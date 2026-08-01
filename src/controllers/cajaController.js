import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import Order from "../models/Order.js";
import CajaSession from "../models/CajaSession.js";
import { User } from "../models/User.js";
import { PAID_STATUSES } from "../utils/constants.js";
import { cuadreZ } from "../incentivos/cuadreZ.js";
import { arqueoCaja } from "../wms/arqueo.js";
import { BadRequestError } from "../utils/errors.js";

const hoyISO = () => new Date().toISOString().slice(0, 10);

// Efectivo cobrado por una cajera desde la apertura de su sesión.
const ventasEfectivoDesde = async (cajeraId, since) => {
  const r = await Order.aggregate([
    {
      $match: {
        "payment.method": "cash_on_pickup",
        "payment.status": "approved",
        "payment.cashier_id": new mongoose.Types.ObjectId(String(cajeraId)),
        paid_at: { $gte: since },
      },
    },
    { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
  ]);
  return { total: r[0]?.total || 0, count: r[0]?.count || 0 };
};

// GET /caja/cierre-z?date=YYYY-MM-DD → cuadre Z (total + por método de pago)
export const getCierreZ = asyncHandler(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : hoyISO();
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${date}T23:59:59.999`);

  // Filtra por paid_at (cuándo se cobró), igual criterio que la sesión de caja,
  // para que el cierre Z cuadre con la suma de sesiones (no por created_at).
  const orders = await Order.find({
    status: mongoose.trusted({ $in: PAID_STATUSES }),
    paid_at: mongoose.trusted({ $gte: start, $lte: end }),
  })
    .select("total payment.method payment.cashier_id")
    .lean();

  // Resuelve el nombre de cada cajera para el desglose "Por cajero".
  const ids = [...new Set(orders.map((o) => o.payment?.cashier_id).filter(Boolean).map(String))];
  const users = ids.length
    ? await User.find({ _id: mongoose.trusted({ $in: ids }) }).select("name email").lean()
    : [];
  const nameById = new Map(users.map((u) => [String(u._id), u.name || u.email]));

  const mapped = orders.map((o) => ({
    total: o.total,
    payment: { method: o.payment?.method || "efectivo" },
    cajero: o.payment?.cashier_id ? nameById.get(String(o.payment.cashier_id)) || "—" : "—",
  }));

  res.json({ success: true, data: { date, ...cuadreZ(mapped) } });
});

// POST /caja/sesion/abrir { monto_inicial } → abre la caja (idempotente por cajera)
export const abrirCaja = asyncHandler(async (req, res) => {
  const cajera_id = req.user?.id;
  const existing = await CajaSession.findOne({ cajera_id, estado: "abierta" }).lean();
  if (existing) return res.json({ success: true, data: { sesion: existing, yaAbierta: true } });
  const monto_inicial = Math.max(0, Math.round(Number(req.body?.monto_inicial) || 0));
  const sesion = await CajaSession.create({
    cajera_id,
    cajera_label: req.user?.name || req.user?.email || "caja",
    monto_inicial,
  });
  res.status(201).json({ success: true, data: { sesion } });
});

// GET /caja/sesion/actual → sesión abierta de la cajera + efectivo esperado en vivo
export const cajaActual = asyncHandler(async (req, res) => {
  const cajera_id = req.user?.id;
  const sesion = await CajaSession.findOne({ cajera_id, estado: "abierta" }).lean();
  if (!sesion) return res.json({ success: true, data: { sesion: null } });
  const ventas = await ventasEfectivoDesde(cajera_id, sesion.created_at);
  res.json({
    success: true,
    data: {
      sesion,
      ventas_efectivo: ventas.total,
      cobros: ventas.count,
      monto_esperado: sesion.monto_inicial + ventas.total,
    },
  });
});

// GET /caja/mi-dia → progreso de la cajera logueada: cobros de hoy y del mes
// (total + count) + desglose por método de hoy. Real por payment.cashier_id.
export const miDia = asyncHandler(async (req, res) => {
  const cajeraId = new mongoose.Types.ObjectId(String(req.user.id));
  const now = new Date();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const m0 = new Date(now.getFullYear(), now.getMonth(), 1);
  const agg = await Order.aggregate([
    { $match: { "payment.cashier_id": cajeraId, "payment.status": "approved", paid_at: { $gte: m0 } } },
    {
      $facet: {
        hoy: [{ $match: { paid_at: { $gte: d0 } } }, { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }],
        mes: [{ $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }],
        porMetodo: [{ $match: { paid_at: { $gte: d0 } } }, { $group: { _id: "$payment.method", total: { $sum: "$total" }, count: { $sum: 1 } } }],
      },
    },
  ]);
  const f = agg[0] || {};
  const one = (a) => (a && a[0]) || { total: 0, count: 0 };
  // porMetodo: { metodo: { total, count } } — el count de 'card' = nº de vouchers/bouchers.
  res.json({
    success: true,
    data: { hoy: one(f.hoy), mes: one(f.mes), porMetodo: Object.fromEntries((f.porMetodo || []).map((x) => [x._id, { total: x.total, count: x.count }])) },
  });
});

// PATCH /caja/sesion/cerrar { monto_contado } → cierra + cuadre (arqueo)
export const cerrarCaja = asyncHandler(async (req, res) => {
  const cajera_id = req.user?.id;
  const sesion = await CajaSession.findOne({ cajera_id, estado: "abierta" });
  if (!sesion) throw new BadRequestError("No tienes una caja abierta");
  const ventas = await ventasEfectivoDesde(cajera_id, sesion.created_at);
  const esperado = sesion.monto_inicial + ventas.total;
  const contado = Math.max(0, Math.round(Number(req.body?.monto_contado) || 0));
  const arq = arqueoCaja(esperado, contado);
  sesion.ventas_efectivo = ventas.total;
  sesion.monto_esperado = esperado;
  sesion.monto_contado = contado;
  sesion.diferencia = arq.diferencia;
  sesion.estado = "cerrada";
  sesion.t_cierre = new Date();
  await sesion.save();
  res.json({ success: true, data: { sesion, arqueo: arq } });
});
