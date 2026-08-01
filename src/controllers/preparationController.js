import mongoose from "mongoose";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { aceptarPicking, actualizarPick, registrarFaltante, empacarYListo } from "../services/preparationService.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { ORDER_STATUS, ROLES } from "../utils/constants.js";
import { logAudit } from "../utils/audit.js";
import { emitRelayChange } from "../utils/relayBus.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";

const buildActor = (reqUser, fallbackLabel = "preparación") => ({
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

// POST /orders/admin/:id/aceptar — se toma el pedido para prepararlo (claim atómico).
export const aceptarHandler = asyncHandler(async (req, res) => {
  const order = await aceptarPicking({ orderId: req.params.id, by: buildActor(req.user) });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/asignar { user_id|null } — admin/gerente ASIGNA el pedido
// a una persona concreta, o lo devuelve a la cola común (user_id: null).
// Solo pedidos paid/preparing. Perm: USERS_MANAGE.
export const asignarHandler = asyncHandler(async (req, res) => {
  const rawId = req.body?.user_id ?? null;
  let assigned = null;
  if (rawId != null) {
    if (!mongoose.isValidObjectId(rawId)) throw new BadRequestError("user_id inválido");
    const picker = await User.findById(rawId).select("name email role is_active").lean();
    if (!picker || picker.is_active === false)
      throw new NotFoundError("Usuario no encontrado o inactivo");
    if (![ROLES.OPERATOR, ROLES.ADMIN].includes(picker.role))
      throw new BadRequestError("Solo se puede asignar a personal de preparación (operator) o admin");
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
    action: "preparacion.asignar",
    target: `Pedido ${String(order._id).slice(-6).toUpperCase()}`,
    detail: assigned ? `Asignado a ${assigned.label}` : "Asignación removida (vuelve a la cola común)",
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
    .select("name email role")
    .sort({ name: 1 })
    .lean();
  return res.status(200).json({ success: true, data: pickers });
});

// PATCH /orders/admin/:id/pick { product_id, picked?, scanned? } — persiste el avance.
export const pickHandler = asyncHandler(async (req, res) => {
  const order = await actualizarPick({ orderId: req.params.id, productId: req.body.product_id, picked: req.body.picked !== false, scanned: !!req.body.scanned });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/faltante { product_id, qty_real?, motivo? } — reporta faltante/dañado.
export const faltanteHandler = asyncHandler(async (req, res) => {
  const order = await registrarFaltante({ orderId: req.params.id, productId: req.body.product_id, qtyReal: req.body.qty_real, motivo: req.body.motivo, by: buildActor(req.user) });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

// POST /orders/admin/:id/listo { bultos?, peso? } — cierre de empaque + transición a ready.
export const listoHandler = asyncHandler(async (req, res) => {
  const order = await empacarYListo({ orderId: req.params.id, bultos: req.body.bultos, peso: req.body.peso, by: buildActor(req.user) });
  return res.status(200).json({ success: true, data: { order: sanitizeOrder(order) } });
});

export default { aceptarHandler, asignarHandler, pickersHandler, pickHandler, faltanteHandler, listoHandler };
