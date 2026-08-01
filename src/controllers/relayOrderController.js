import mongoose from "mongoose";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { createTakeOrder, cobrarPedido, aceptarPicking, misMetricasVendedor, misPedidosVendedor, actualizarPick, registrarFaltante, empacarYListo } from "../services/relayOrderService.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { ORDER_STATUS, ROLES } from "../utils/constants.js";
import { logAudit } from "../utils/audit.js";
import { emitRelayChange } from "../utils/relayBus.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";

const buildActor = (reqUser, fallbackLabel = "vendedor") => ({
  user_id: reqUser?.id || null,
  role: reqUser?.role || null,
  label: reqUser?.name || reqUser?.email || fallbackLabel,
});

const sanitizeOrder = (order) => {
  if (!order) return null;
  if (typeof order.toJSON === "function") return order.toJSON();
  const clone = { ...order };
  delete clone.guest_token_hash;
  return clone;
};

// POST /orders/admin/take — vendedor cierra el pedido en POR_PAGAR (+ boleta).
export const takeOrderHandler = asyncHandler(async (req, res) => {
  const { items, customer, turno_id, notes } = req.body;
  const order = await createTakeOrder({
    items,
    customer,
    turno_id,
    notes,
    by: buildActor(req.user, "vendedor"),
  });
  return res.status(201).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// GET /orders/admin/by-scan/:codigo — la cajera escanea la boleta y trae el pedido.
export const findOrderByScanHandler = asyncHandler(async (req, res) => {
  const codigo = String(req.params.codigo || "").trim();
  // El código de escaneo ES el _id de la orden (lo lleva el QR/Code128 de la boleta).
  const query = mongoose.isValidObjectId(codigo)
    ? { $or: [{ codigo_escaneo: codigo }, { _id: codigo }] }
    : { codigo_escaneo: codigo };
  let order = await Order.findOne(query).lean();
  // Fallback: FOLIO CORTO (los últimos 6 del _id, tal como se ve impreso). Permite que
  // la cajera ESCRIBA "D9FE9B" además de escanear el QR con el código completo. Sin $expr
  // (choca con sanitizeFilter): match por sufijo sobre los pedidos recientes.
  // Mínimo 6 hex (menos es demasiado ambiguo) y si hay más de un match → 409.
  if (!order && /^[a-f0-9]{6,12}$/i.test(codigo)) {
    const suf = codigo.toLowerCase();
    const recientes = await Order.find({}, { _id: 1 }).sort({ created_at: -1 }).limit(400).lean();
    const hits = recientes.filter((o) => String(o._id).endsWith(suf));
    if (hits.length > 1) throw new ConflictError("Folio ambiguo, usa el código completo");
    if (hits.length === 1) order = await Order.findById(hits[0]._id).lean();
  }
  if (!order) throw new NotFoundError("No se encontró el pedido para ese código");
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/cobrar { metodo, amount_received?, cliente_rut?, override? }
// — la cajera cobra → PAGADO. "credito" valida al cliente y genera la Deuda.
export const cobrarHandler = asyncHandler(async (req, res) => {
  const { metodo, amount_received, cliente_rut, override } = req.body;
  const order = await cobrarPedido({
    orderId: req.params.id,
    metodo,
    amountReceived: amount_received,
    clienteRut: cliente_rut,
    override,
    by: buildActor(req.user, "caja"),
  });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/aceptar — el bodeguero toma el pedido (claim atómico).
export const aceptarHandler = asyncHandler(async (req, res) => {
  const order = await aceptarPicking({ orderId: req.params.id, by: buildActor(req.user, "bodega") });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/asignar { user_id|null } — el súper-admin ASIGNA el pedido
// a un picker específico (características especiales) o lo devuelve a la cola FIFO
// (user_id: null). Solo pedidos paid/preparing. Perm: USERS_MANAGE.
export const asignarHandler = asyncHandler(async (req, res) => {
  const rawId = req.body?.user_id ?? null;
  let assigned = null;
  if (rawId != null) {
    if (!mongoose.isValidObjectId(rawId)) throw new BadRequestError("user_id inválido");
    const picker = await User.findById(rawId).select("name email role is_active").lean();
    if (!picker || picker.is_active === false)
      throw new NotFoundError("Usuario no encontrado o inactivo");
    if (![ROLES.OPERATOR, ROLES.ADMIN].includes(picker.role))
      throw new BadRequestError("Solo se puede asignar a bodegueros (operator) o admin");
    assigned = { user_id: picker._id, label: picker.name || picker.email || "" };
  }

  // Guard de estado en el update (sin ventana): solo paid/preparing es asignable.
  const order = await Order.findOneAndUpdate(
    {
      _id: req.params.id,
      status: mongoose.trusted({ $in: [ORDER_STATUS.PAID, ORDER_STATUS.PREPARING] }),
    },
    { $set: { assigned_to: assigned } },
    { new: true },
  );
  if (!order) {
    const exists = await Order.findById(req.params.id).select("status").lean();
    if (!exists) throw new NotFoundError("Pedido no encontrado");
    throw new ConflictError("Solo se puede asignar un pedido pagado o en preparación");
  }

  emitRelayChange({ type: "assign", id: String(order._id) });
  logAudit({
    req,
    action: "picking.asignar",
    target: `Pedido ${String(order._id).slice(-6).toUpperCase()}`,
    detail: assigned
      ? `Asignado a ${assigned.label}`
      : "Asignación removida (vuelve a la cola FIFO)",
  });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// GET /orders/admin/pickers — usuarios asignables para el selector de asignación:
// activos con rol operator|admin. Perm: USERS_MANAGE.
export const pickersHandler = asyncHandler(async (req, res) => {
  const pickers = await User.find({
    is_active: true,
    role: mongoose.trusted({ $in: [ROLES.OPERATOR, ROLES.ADMIN] }),
  })
    // face_descriptors es select:false; lo pedimos SOLO para derivar has_face y no
    // exponemos los descriptores crudos (dato biométrico) en la respuesta.
    .select("name email picker_nivel picker_pin role +face_descriptors")
    .sort({ name: 1 })
    .lean();
  const data = pickers.map(({ face_descriptors, ...u }) => ({
    ...u,
    has_face: Array.isArray(face_descriptors) && face_descriptors.length > 0,
  }));
  return res.status(200).json({ success: true, data });
});

// POST /orders/admin/pickers/:id/face { descriptors: number[][] } — el gerente registra
// (o borra) el rostro del picker para el tótem. Cada muestra es un descriptor de 128
// floats que face-api.js calcula en el navegador. descriptors:[] → borra el registro.
// Perm: USERS_MANAGE. NUNCA devuelve los descriptores (dato biométrico).
export const pickerFaceHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError("id inválido");
  const { descriptors } = req.body;
  if (!Array.isArray(descriptors)) throw new BadRequestError("descriptors debe ser un arreglo");
  if (descriptors.length > 5) throw new BadRequestError("Máximo 5 muestras");
  for (const muestra of descriptors) {
    if (!Array.isArray(muestra) || muestra.length !== 128)
      throw new BadRequestError("Cada muestra debe tener 128 números");
    if (!muestra.every((n) => typeof n === "number" && Number.isFinite(n)))
      throw new BadRequestError("Cada muestra debe contener solo números finitos");
  }

  // Mismo criterio de "picker válido" que resolverPicker/pickersHandler.
  const picker = await User.findOneAndUpdate(
    { _id: req.params.id, role: mongoose.trusted({ $in: [ROLES.OPERATOR, ROLES.ADMIN] }) },
    { $set: { face_descriptors: descriptors } },
    { new: true },
  ).select("name email +face_descriptors").lean();
  if (!picker) throw new NotFoundError("Picker no encontrado");

  const samples = Array.isArray(picker.face_descriptors) ? picker.face_descriptors.length : 0;
  logAudit({
    req,
    action: "picker.face",
    target: picker.name || picker.email,
    detail: samples > 0 ? `Rostro registrado (${samples} muestras)` : "Rostro eliminado",
  });
  return res.status(200).json({ success: true, data: { has_face: samples > 0, samples } });
});

// POST /orders/admin/pickers/:id/config { nivel?, pin? } — el gerente fija el NIVEL
// (nuevo/experto) y el PIN del tótem de un picker. Perm: USERS_MANAGE.
export const pickerConfigHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError("id inválido");
  const { nivel, pin } = req.body;
  const set = {};
  if (nivel != null) {
    if (!["nuevo", "experto"].includes(nivel)) throw new BadRequestError("Nivel inválido");
    set.picker_nivel = nivel;
  }
  if (pin !== undefined) {
    const p = String(pin || "").trim();
    if (p && !/^\d{4,8}$/.test(p)) throw new BadRequestError("El PIN debe tener 4 a 8 dígitos");
    if (p) {
      const dup = await User.findOne({
        picker_pin: p,
        _id: mongoose.trusted({ $ne: new mongoose.Types.ObjectId(req.params.id) }),
      }).select("_id").lean();
      if (dup) throw new ConflictError("Ese PIN ya lo usa otro picker");
    }
    set.picker_pin = p || null;
  }
  if (!Object.keys(set).length) throw new BadRequestError("Nada para actualizar");

  const picker = await User.findOneAndUpdate(
    { _id: req.params.id, role: mongoose.trusted({ $in: [ROLES.OPERATOR, ROLES.ADMIN] }) },
    { $set: set },
    { new: true },
  ).select("name email picker_nivel picker_pin").lean();
  if (!picker) throw new NotFoundError("Picker no encontrado");

  logAudit({
    req,
    action: "picker.config",
    target: picker.name || picker.email,
    detail: `nivel=${picker.picker_nivel}${set.picker_pin !== undefined ? " · PIN actualizado" : ""}`,
  });
  return res.status(200).json({ success: true, data: picker });
});

// GET /orders/admin/mis-metricas — el vendedor ve SUS ventas/clientes + incentivos.
export const misMetricasHandler = asyncHandler(async (req, res) => {
  const data = await misMetricasVendedor({ userId: req.user.id });
  return res.status(200).json({ success: true, data });
});

// GET /orders/admin/mis-pedidos — historial de boletas del vendedor.
export const misPedidosHandler = asyncHandler(async (req, res) => {
  const data = await misPedidosVendedor({ userId: req.user.id, limit: req.query.limit });
  return res.status(200).json({ success: true, data });
});

// PATCH /orders/admin/:id/pick { product_id, picked?, scanned? } — persiste el avance del pickeo.
export const pickHandler = asyncHandler(async (req, res) => {
  const order = await actualizarPick({ orderId: req.params.id, productId: req.body.product_id, picked: req.body.picked !== false, scanned: !!req.body.scanned });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/faltante { product_id, qty_real?, motivo? } — reporta faltante/dañado.
export const faltanteHandler = asyncHandler(async (req, res) => {
  const order = await registrarFaltante({ orderId: req.params.id, productId: req.body.product_id, qtyReal: req.body.qty_real, motivo: req.body.motivo, by: buildActor(req.user, "bodega") });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/listo { bultos?, peso? } — cierre de empaque + transición a ready.
export const listoHandler = asyncHandler(async (req, res) => {
  const order = await empacarYListo({ orderId: req.params.id, bultos: req.body.bultos, peso: req.body.peso, by: buildActor(req.user, "bodega") });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

export default { takeOrderHandler, findOrderByScanHandler, cobrarHandler, aceptarHandler, asignarHandler, pickersHandler, pickerConfigHandler, pickerFaceHandler, misMetricasHandler, misPedidosHandler, pickHandler, faltanteHandler, listoHandler };
