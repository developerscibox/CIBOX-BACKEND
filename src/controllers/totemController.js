import mongoose from "mongoose";

import { asyncHandler } from "../middlewares/errorHandler.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import { ROLES } from "../utils/constants.js";
import { aceptarPicking, empacarYListo, colaParaPicker } from "../services/relayOrderService.js";
import { BadRequestError, NotFoundError, ForbiddenError } from "../utils/errors.js";

// TÓTEM DE PICKING (kiosko para bodegueros). El picker se identifica con su PIN (el
// lector facial/huella real reemplaza este paso más adelante), ve su cola gateada por
// nivel, toma un pedido (imprime ticket) y al terminar vuelve a finalizarlo. PÚBLICO:
// no hay JWT, el PIN autoriza la acción del picker específico (rutas con rate limit).

const sanitizeOrder = (order) => {
  if (!order) return null;
  const o = typeof order.toJSON === "function" ? order.toJSON() : { ...order };
  delete o.guest_token_hash;
  return o;
};

// Resuelve al picker por su PIN (bodeguero/admin activo). Lanza si no matchea.
const resolverPicker = async (pin) => {
  const p = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(p)) throw new BadRequestError("PIN inválido (4 a 8 dígitos)");
  const u = await User.findOne({
    picker_pin: p,
    is_active: true,
    role: mongoose.trusted({ $in: [ROLES.OPERATOR, ROLES.ADMIN] }),
  })
    .select("_id name picker_nivel role")
    .lean();
  if (!u) throw new NotFoundError("PIN no reconocido");
  return u;
};

const pickerDTO = (u) => ({ id: String(u._id), nombre: u.name, nivel: u.picker_nivel || "experto" });

// POST /orders/totem/identificar { pin }
export const totemIdentificar = asyncHandler(async (req, res) => {
  const picker = await resolverPicker(req.body.pin);
  res.json({ success: true, data: { picker: pickerDTO(picker) } });
});

// Umbral de aceptación del matching facial (distancia euclidiana). face-api.js usa
// típicamente 0.6; bajamos a 0.5 para exigir mayor confianza en un kiosko interno.
const FACE_UMBRAL = 0.5;

// Distancia euclidiana entre dos descriptores de 128 dimensiones.
const distanciaEuclidiana = (a, b) => {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
};

// POST /orders/totem/identificar-facial { descriptor: number[128] }
// El navegador (face-api.js) manda el descriptor del rostro capturado; acá buscamos
// al picker con la muestra más cercana. PÚBLICO como /identificar (kiosko interno).
export const totemIdentificarFacial = asyncHandler(async (req, res) => {
  const descriptor = req.body.descriptor;
  if (!Array.isArray(descriptor) || descriptor.length !== 128)
    throw new BadRequestError("descriptor inválido (se esperan 128 números)");
  if (!descriptor.every((n) => typeof n === "number" && Number.isFinite(n)))
    throw new BadRequestError("descriptor inválido (valores no finitos)");

  // Mismo criterio de picker válido que resolverPicker (activo + bodeguero/admin), y
  // además CON rostro registrado y CON pin (el pin es necesario para las acciones
  // siguientes del tótem: tablero/tomar/finalizar). face_descriptors es select:false.
  const candidatos = await User.find({
    is_active: true,
    role: mongoose.trusted({ $in: [ROLES.OPERATOR, ROLES.ADMIN] }),
    picker_pin: mongoose.trusted({ $ne: null }),
    "face_descriptors.0": mongoose.trusted({ $exists: true }),
  })
    .select("_id name picker_nivel picker_pin +face_descriptors")
    .lean();

  let mejor = null; // { user, dist }
  for (const u of candidatos) {
    for (const muestra of u.face_descriptors) {
      if (!Array.isArray(muestra) || muestra.length !== 128) continue;
      const dist = distanciaEuclidiana(descriptor, muestra);
      if (!mejor || dist < mejor.dist) mejor = { user: u, dist };
    }
  }

  if (!mejor || mejor.dist >= FACE_UMBRAL)
    throw new NotFoundError("Rostro no reconocido. Usa tu PIN.");

  // Devolvemos el pin A PROPÓSITO: el kiosko es interno y así el cliente reutiliza el
  // flujo existente (tablero/tomar/finalizar) sin cambios, tal como si el picker lo
  // hubiera tecleado. El rostro solo reemplaza el paso de tipear el PIN.
  const u = mejor.user;
  res.json({
    success: true,
    data: {
      picker: { id: String(u._id), name: u.name, nivel: u.picker_nivel || "experto" },
      pin: u.picker_pin,
      dist: Math.round(mejor.dist * 1000) / 1000,
    },
  });
});

// POST /orders/totem/tablero { pin } → cola disponible (gateada) + en curso del picker.
export const totemTablero = asyncHandler(async (req, res) => {
  const picker = await resolverPicker(req.body.pin);
  const cola = await colaParaPicker({ pickerId: picker._id, nivel: picker.picker_nivel });
  res.json({ success: true, data: { picker: pickerDTO(picker), ...cola } });
});

// POST /orders/totem/tomar { pin, order_id } → claim + asigna al picker.
export const totemTomar = asyncHandler(async (req, res) => {
  const picker = await resolverPicker(req.body.pin);
  const orderId = req.body.order_id;
  if (!mongoose.isValidObjectId(orderId)) throw new BadRequestError("order_id inválido");

  const by = { user_id: picker._id, role: picker.role, label: picker.name, nivel: picker.picker_nivel };
  const order = await aceptarPicking({ orderId, by }); // valida nivel + FIFO + claim atómico
  // Queda ASIGNADO al picker: para listarlo en SUS "en curso" y que él lo finalice.
  await Order.updateOne(
    { _id: order._id },
    { $set: { assigned_to: { user_id: picker._id, label: picker.name, role: picker.role } } },
  );
  res.json({ success: true, data: { order: sanitizeOrder(order), picker: pickerDTO(picker) } });
});

// POST /orders/totem/finalizar { pin, order_id, bultos? } → empaca + listo para retiro.
export const totemFinalizar = asyncHandler(async (req, res) => {
  const picker = await resolverPicker(req.body.pin);
  const orderId = req.body.order_id;
  if (!mongoose.isValidObjectId(orderId)) throw new BadRequestError("order_id inválido");

  const ord = await Order.findById(orderId).select("assigned_to status").lean();
  if (!ord) throw new NotFoundError("Pedido no encontrado");
  if (String(ord.assigned_to?.user_id || "") !== String(picker._id)) {
    throw new ForbiddenError("Ese pedido no está a tu cargo");
  }
  const by = { user_id: picker._id, role: picker.role, label: picker.name };
  const bultos = req.body.bultos != null ? Number(req.body.bultos) : null;
  const order = await empacarYListo({ orderId, bultos, by });
  res.json({ success: true, data: { order: sanitizeOrder(order), picker: pickerDTO(picker) } });
});

export default { totemIdentificar, totemIdentificarFacial, totemTablero, totemTomar, totemFinalizar };
