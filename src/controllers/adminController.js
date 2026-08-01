import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  PAID_STATUSES,
  ROLES,
} from "../utils/constants.js";

import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Vendor from "../models/Vendor.js";
import { User } from "../models/User.js";
import AuditLog from "../models/AuditLog.js";
import { logAudit } from "../utils/audit.js";

// Helpers ----------------------------------------------------------------

const buildDateMatch = (from, to) => {
  if (!from && !to) return null;
  // Una fecha sin hora (Zod la coerce a medianoche UTC) en `to` debe INCLUIR todo
  // ese día; si no, las ventas de hoy quedaban fuera (parecía $0). Se detecta el
  // medianoche-UTC exacto y se extiende al fin del día.
  const isMidnightUTC = (d) =>
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) {
    const t = new Date(to);
    if (isMidnightUTC(t)) t.setUTCHours(23, 59, 59, 999);
    range.$lte = t;
  }
  return range;
};

const tryImport = async (path) => {
  try {
    return (await import(path)).default;
  } catch {
    return null;
  }
};

const safeCreateNotification = async (payload) => {
  if (!payload?.userId) return;
  const notif = await tryImport("../utils/notification.js");
  if (notif?.createNotification) {
    try {
      await notif.createNotification(payload);
    } catch (err) {
      logger.warn({ err: err.message }, "createNotification failed");
    }
  }
};

// Sales summary (paid only) ---------------------------------------------

export const getSalesSummary = asyncHandler(async (req, res) => {
  const { from, to, vendor_id, group_by } = req.query;

  const match = { status: { $in: PAID_STATUSES } };
  const dateMatch = buildDateMatch(from, to);
  if (dateMatch) match.created_at = dateMatch;
  if (vendor_id) match["items.vendor.id"] = vendor_id;

  // Agrupación por día/mes/trimestre. El trimestre se arma con año + Q calculado
  // (ceil(mes/3)) porque $dateToString no tiene token de trimestre.
  let groupId;
  if (group_by === "quarter") {
    groupId = {
      $concat: [
        { $toString: { $year: "$created_at" } },
        "-T",
        { $toString: { $ceil: { $divide: [{ $month: "$created_at" }, 3] } } },
      ],
    };
  } else if (group_by === "week") {
    // Año-semana ISO (ej "2026-S26").
    groupId = { $dateToString: { format: "%G-S%V", date: "$created_at" } };
  } else {
    const dateFormat = group_by === "month" ? "%Y-%m" : "%Y-%m-%d";
    groupId = { $dateToString: { format: dateFormat, date: "$created_at" } };
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: groupId,
        total_orders: { $sum: 1 },
        total_sales: { $sum: "$total" },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        period: "$_id",
        total_orders: 1,
        total_sales: 1,
        average_ticket: {
          $cond: [
            { $gt: ["$total_orders", 0] },
            { $divide: ["$total_sales", "$total_orders"] },
            0,
          ],
        },
      },
    },
  ];

  const series = await Order.aggregate(pipeline);
  const totals = series.reduce(
    (acc, p) => {
      acc.total_orders += p.total_orders;
      acc.total_sales += p.total_sales;
      return acc;
    },
    { total_orders: 0, total_sales: 0 }
  );
  totals.average_ticket =
    totals.total_orders > 0 ? Math.round(totals.total_sales / totals.total_orders) : 0;

  res.json({ success: true, data: { totals, series } });
});

export const getTopSellingProducts = asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const match = { status: { $in: PAID_STATUSES } };
  const dateMatch = buildDateMatch(req.query.from, req.query.to);
  if (dateMatch) match.created_at = dateMatch;

  const top = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product_id",
        name: { $first: "$items.name" },
        total_quantity: { $sum: "$items.quantity" },
        total_revenue: { $sum: "$items.subtotal" },
      },
    },
    { $sort: { total_quantity: -1 } },
    { $limit: limit },
  ]);

  res.json({ success: true, data: top });
});

// Menos vendidos (rotación baja) — mismos datos que top pero ascendente. Sirve
// para detectar productos a liquidar. Real (sobre lo vendido), no mock.
export const getBottomSellingProducts = asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const match = { status: { $in: PAID_STATUSES } };
  const dateMatch = buildDateMatch(req.query.from, req.query.to);
  if (dateMatch) match.created_at = dateMatch;

  const bottom = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product_id",
        name: { $first: "$items.name" },
        total_quantity: { $sum: "$items.quantity" },
        total_revenue: { $sum: "$items.subtotal" },
      },
    },
    { $sort: { total_quantity: 1 } },
    { $limit: limit },
  ]);

  res.json({ success: true, data: bottom });
});

// POST /admin/demo/reseed — regenera los datos demo del relay (entregados hoy con
// tiempos retrodatados) para la demostración. Idempotente (borra los previos).
export const reseedDemo = asyncHandler(async (req, res) => {
  const { seedRelayDemo } = await import("../scripts/seedRelayDemo.js");
  const r = await seedRelayDemo();
  res.json({ success: true, data: r });
});

// POST /admin/demo/seed-all — recarga del dataset de demo completo (mantiene "hoy"
// fresco). Solo USERS_MANAGE. Se retira en la limpieza final antes del lanzamiento real.
export const reseedDemoAll = asyncHandler(async (req, res) => {
  const { seedDemoAll } = await import("../scripts/seedDemoAll.js");
  const r = await seedDemoAll();
  res.json({ success: true, data: r });
});

// GET /admin/desempeno — DESEMPEÑO POR ÁREAS (en vivo): cada área (Ventas, Caja,
// Preparación) con su meta del día, su total logrado, % de cumplimiento y sus
// miembros con la meta y el avance individual. Ventas se atribuye por Order.seller;
// Caja y Preparación por el status_history del día (por persona).
// Inicio del día actual en America/Santiago como instante UTC. El servidor corre
// en UTC (Render): con setHours(0,0,0,0) "hoy" se vaciaba a las 20/21h de Chile.
// Mismo patrón que santiagoDayRange de orderController (offset real, maneja DST).
const startOfTodaySantiago = () => {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${ymd}T12:00:00Z`))
    .find((p) => p.type === "timeZoneName")?.value || "GMT-04:00";
  const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(off);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const start = new Date(`${ymd}T00:00:00Z`);
  start.setUTCMinutes(start.getUTCMinutes() - offsetMin);
  return start;
};

const META_DESEMPENO = {
  ventasPorVendedor: 500000, // $ vendidos por vendedor/día
  cobrosPorCajera: 750000,   // $ cobrados por cajera/día
  pedidosPorBodeguero: 8,    // pedidos preparados por bodeguero/día
};

export const getDesempeno = asyncHandler(async (req, res) => {
  const now = new Date();
  const startOfDay = startOfTodaySantiago();
  const M = META_DESEMPENO;
  const pct = (v, meta) => (meta > 0 ? Math.round((v / meta) * 100) : 0);

  const [ventasOrders, histOrders] = await Promise.all([
    Order.find({
      created_at: mongoose.trusted({ $gte: startOfDay }),
      status: mongoose.trusted({ $ne: "cancelled" }),
    }).select("seller total items").lean(),
    Order.find({ "status_history.changed_at": mongoose.trusted({ $gte: startOfDay }) })
      .select("total status_history").lean(),
  ]);

  // Ventas por vendedor (Order.seller)
  const vend = new Map();
  for (const o of ventasOrders) {
    if (!o.seller?.id) continue;
    const k = String(o.seller.id);
    if (!vend.has(k)) vend.set(k, { nombre: o.seller.nombre || "Vendedor", monto: 0, unidades: 0, pedidos: 0 });
    const m = vend.get(k);
    m.monto += o.total || 0;
    m.unidades += (o.items || []).reduce((s, it) => s + (it.quantity || 0), 0);
    m.pedidos += 1;
  }

  // Caja (cajera) y Preparación (bodeguero) desde el status_history de hoy
  const caja = new Map(), bod = new Map();
  for (const o of histOrders) {
    for (const h of o.status_history || []) {
      const t = new Date(h.changed_at).getTime();
      if (!Number.isFinite(t) || t < startOfDay.getTime()) continue;
      const label = h.changed_by?.label, role = h.changed_by?.role;
      if (!label) continue;
      if (role === "cashier" && h.status === "paid") {
        if (!caja.has(label)) caja.set(label, { nombre: label, monto: 0, cobros: 0 });
        const m = caja.get(label); m.monto += o.total || 0; m.cobros += 1;
      }
      if (role === "operator" && h.status === "ready") {
        if (!bod.has(label)) bod.set(label, { nombre: label, pedidos: 0 });
        bod.get(label).pedidos += 1;
      }
    }
  }

  const mkArea = (id, nombre, icono, unidad, miembros) => {
    const total = miembros.reduce((s, m) => s + m.valor, 0);
    const metaTotal = miembros.reduce((s, m) => s + m.meta, 0);
    return { id, nombre, icono, unidad, total, metaTotal, pct: pct(total, metaTotal), miembros: miembros.sort((a, b) => b.pct - a.pct) };
  };

  const areas = [
    mkArea("ventas", "Ventas en sala", "🛒", "$", [...vend.values()].map((m) => ({
      nombre: m.nombre, valor: m.monto, meta: M.ventasPorVendedor, pct: pct(m.monto, M.ventasPorVendedor), extra: `${m.pedidos} ped · ${m.unidades} u`,
    }))),
    mkArea("caja", "Caja", "💵", "$", [...caja.values()].map((m) => ({
      nombre: m.nombre, valor: m.monto, meta: M.cobrosPorCajera, pct: pct(m.monto, M.cobrosPorCajera), extra: `${m.cobros} cobros`,
    }))),
    mkArea("bodega", "Preparación (bodega)", "🧺", "ped", [...bod.values()].map((m) => ({
      nombre: m.nombre, valor: m.pedidos, meta: M.pedidosPorBodeguero, pct: pct(m.pedidos, M.pedidosPorBodeguero), extra: "preparados hoy",
    }))),
  ];

  const resumen = {
    areas: areas.length,
    en_meta: areas.filter((a) => a.pct >= 100).length,
    miembros: areas.reduce((s, a) => s + a.miembros.length, 0),
    cumplimiento_promedio: areas.length ? Math.round(areas.reduce((s, a) => s + a.pct, 0) / areas.length) : 0,
  };

  res.json({ success: true, data: { areas, resumen, now } });
});

// GET /admin/actividad — tablero de ACTIVIDAD EN VIVO para el gerente: quién está
// conectado, qué está haciendo cada uno (pedido en preparación), quién está en
// TIEMPO MUERTO (conectado sin acción reciente) y cuánto trabajó hoy. Deriva la
// presencia de User.last_seen y la actividad del status_history de los pedidos.
export const getActividad = asyncHandler(async (req, res) => {
  const STAFF = [ROLES.ADMIN, ROLES.MANAGER, ROLES.VENDEDOR, ROLES.CASHIER, ROLES.OPERATOR, ROLES.PANTALLA];
  const now = Date.now();
  const startOfDay = startOfTodaySantiago();

  const users = await User.find({ role: mongoose.trusted({ $in: STAFF }) })
    .select("name email role last_seen is_active")
    .lean();

  const orders = await Order.find({
    $or: [
      { status: "preparing" },
      { "status_history.changed_at": mongoose.trusted({ $gte: startOfDay }) },
    ],
  })
    .select("status assigned_to status_history customer total")
    .lean();

  const folioOf = (o) => String(o._id).slice(-6).toUpperCase();
  const byUser = new Map();
  const ensure = (id) => {
    if (!byUser.has(id)) byUser.set(id, { lastAction: null, actionsToday: 0, task: null });
    return byUser.get(id);
  };

  for (const o of orders) {
    if (o.status === "preparing" && o.assigned_to?.user_id) {
      const u = ensure(String(o.assigned_to.user_id));
      u.task = { folio: folioOf(o), cliente: o.customer?.fullName || "Mostrador", total: o.total || 0 };
    }
    for (const h of o.status_history || []) {
      const uid = h.changed_by?.user_id ? String(h.changed_by.user_id) : null;
      if (!uid) continue;
      const t = new Date(h.changed_at).getTime();
      if (!Number.isFinite(t) || t < startOfDay.getTime()) continue;
      const u = ensure(uid);
      u.actionsToday += 1;
      if (!u.lastAction || t > u.lastAction.t) u.lastAction = { t, note: h.note || h.status };
    }
  }

  const CONNECTED_MS = 3 * 60 * 1000; // conectado si last_seen < 3 min
  const IDLE_MS = 8 * 60 * 1000; // tiempo muerto: conectado pero sin acción > 8 min

  const items = users.map((u) => {
    const d = byUser.get(String(u._id)) || {};
    const lastSeen = u.last_seen ? new Date(u.last_seen).getTime() : null;
    const conectado = lastSeen != null && now - lastSeen < CONNECTED_MS;
    const lastActionAgo = d.lastAction ? now - d.lastAction.t : null;
    let estado = "offline";
    if (conectado) {
      if (d.task) estado = "ocupado";
      else if (lastActionAgo != null && lastActionAgo < IDLE_MS) estado = "activo";
      else estado = "tiempo_muerto";
    } else if (lastSeen != null) {
      estado = "ausente"; // se conectó hoy pero no en los últimos minutos
    }
    return {
      id: String(u._id),
      nombre: u.name,
      email: u.email,
      role: u.role,
      activo: u.is_active !== false,
      estado,
      last_seen: u.last_seen || null,
      hace_min: lastSeen != null ? Math.floor((now - lastSeen) / 60000) : null,
      ultima_accion: d.lastAction ? { nota: d.lastAction.note, hace_min: Math.floor(lastActionAgo / 60000) } : null,
      acciones_hoy: d.actionsToday || 0,
      tarea: d.task || null,
    };
  });

  const rank = { ocupado: 0, activo: 1, tiempo_muerto: 2, ausente: 3, offline: 4 };
  items.sort((a, b) => (rank[a.estado] - rank[b.estado]) || (b.acciones_hoy - a.acciones_hoy));

  const resumen = {
    conectados: items.filter((i) => ["activo", "ocupado", "tiempo_muerto"].includes(i.estado)).length,
    ocupados: items.filter((i) => i.estado === "ocupado").length,
    tiempo_muerto: items.filter((i) => i.estado === "tiempo_muerto").length,
    acciones_hoy: items.reduce((s, i) => s + i.acciones_hoy, 0),
  };

  res.json({ success: true, data: { items, resumen, now: new Date() } });
});

export const getDashboardMetrics = asyncHandler(async (req, res) => {
  const [
    paidOrdersAgg,
    activeUsers,
    activeProducts,
    totalVendors,
    pendingVendors,
  ] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: PAID_STATUSES } } },
      { $group: { _id: null, total_sales: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    User.countDocuments({ is_active: true }),
    Product.countDocuments({ is_active: true }),
    Vendor.countDocuments({ is_active: true }),
    Vendor.countDocuments({ is_verified: false, is_active: true }),
  ]);

  const sales = paidOrdersAgg[0] || { total_sales: 0, count: 0 };

  res.json({
    success: true,
    data: {
      total_sales: sales.total_sales,
      paid_orders: sales.count,
      active_users: activeUsers,
      active_products: activeProducts,
      total_vendors: totalVendors,
      pending_vendors: pendingVendors,
    },
  });
});

// Orders -----------------------------------------------------------------

export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { newStatus, reason } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) throw new NotFoundError("Orden no encontrada");

  // Aplica la transición vía el servicio canónico: valida la FSM, repone/asigna
  // stock al cancelar y descuenta el físico en el pick (→ready/shipped). Antes
  // esta ruta hacía un save crudo (se saltaba el pick) y llamaba cancelOrder con
  // la firma equivocada (orderId quedaba undefined → siempre fallaba).
  const { transitionOrderStatus } = await import("../services/orderService.js");
  const updated = await transitionOrderStatus({
    orderId: order._id,
    newStatus,
    byAdmin: true,
    by: { user_id: req.user.id, role: req.user.role, label: req.user.email || "admin" },
    note: reason,
  });

  // Skip si guest (user_id null)
  if (order.user_id) {
    await safeCreateNotification({
      userId: order.user_id,
      type: "order_status_changed",
      title: "Actualización de pedido",
      message: `Tu pedido ${order._id} cambió a estado: ${newStatus}.`,
      data: { order_id: order._id, status: newStatus },
    });
  }

  logger.info(
    { order_id: String(order._id), to: newStatus, by: req.user.id },
    "order status updated (admin)"
  );
  res.json({ success: true, data: updated, message: "Estado actualizado" });
});

export const listOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, vendor_id, user_id, from, to } = req.query;
  const filters = {};
  if (status) filters.status = status;
  if (user_id) filters.user_id = user_id;
  if (vendor_id) filters["items.vendor.id"] = vendor_id;
  const dateMatch = buildDateMatch(from, to);
  if (dateMatch) filters.created_at = dateMatch;

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Order.find(filters).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filters),
  ]);

  res.json({
    success: true,
    data: {
      items,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    },
  });
});

// Users ------------------------------------------------------------------

export const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;

  if (String(req.params.id) === String(req.user.id)) {
    throw new ForbiddenError("No puedes cambiar tu propio rol");
  }
  if (role === ROLES.ADMIN && req.user.role !== ROLES.ADMIN) {
    throw new ForbiddenError("Solo un administrador puede asignar el rol 'admin'");
  }

  const target = await User.findById(req.params.id).lean();
  if (!target) throw new NotFoundError("Usuario no encontrado");

  // No dejar 0 administradores activos al degradar al último admin
  if (target.role === ROLES.ADMIN && role !== ROLES.ADMIN) {
    const activeAdmins = await User.countDocuments({
      role: ROLES.ADMIN,
      is_active: true,
    });
    if (activeAdmins <= 1) {
      throw new ConflictError("Debe quedar al menos un administrador");
    }
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { role },
    { new: true, runValidators: true }
  ).lean();
  if (!user) throw new NotFoundError("Usuario no encontrado");
  logger.info({ user_id: String(user._id), role, by: req.user.id }, "user role updated");
  logAudit({ req, action: "usuario.rol", target: user.name || user.email, detail: `rol → ${role}` });
  res.json({ success: true, data: user, message: "Rol actualizado" });
});

export const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, search, role, is_active } = req.query;
  const filters = {};
  if (role) filters.role = role;
  if (is_active !== undefined) filters.is_active = is_active;
  if (search) {
    const safe = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = mongoose.trusted({ $regex: safe, $options: "i" });
    filters.$or = [{ name: re }, { email: re }];
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    User.find(filters)
      .select("-password_hash -refresh_token_hashes")
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filters),
  ]);

  res.json({
    success: true,
    data: {
      items,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    },
  });
});

export const toggleUserActive = asyncHandler(async (req, res) => {
  const { is_active } = req.body;

  if (String(req.params.id) === String(req.user.id) && is_active === false) {
    throw new ForbiddenError("No puedes desactivarte a ti mismo");
  }

  const target = await User.findById(req.params.id).lean();
  if (!target) throw new NotFoundError("Usuario no encontrado");

  // No dejar 0 administradores activos al desactivar al último admin
  if (target.role === ROLES.ADMIN && target.is_active && is_active === false) {
    const activeAdmins = await User.countDocuments({
      role: ROLES.ADMIN,
      is_active: true,
    });
    if (activeAdmins <= 1) {
      throw new ConflictError("Debe quedar al menos un administrador");
    }
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { is_active },
    { new: true, runValidators: true }
  ).lean();
  if (!user) throw new NotFoundError("Usuario no encontrado");
  logger.info({ user_id: String(user._id), is_active, by: req.user.id }, "user active toggled");
  logAudit({ req, action: "usuario.estado", target: user.name || user.email, detail: is_active ? "activado" : "desactivado" });
  res.json({ success: true, data: user });
});

// GET /admin/audit?limit → bitácora de acciones sensibles (reciente primero)
export const getAudit = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const items = await AuditLog.find({}).sort({ at: -1 }).limit(limit).lean();
  res.json({ success: true, data: { items } });
});

// CSV export -------------------------------------------------------------

const csvEscape = (val) => {
  if (val === null || val === undefined) return "";
  const s = String(val).replace(/"/g, '""');
  if (/[",\n\r]/.test(s)) return `"${s}"`;
  return s;
};

export const exportOrdersCSV = asyncHandler(async (req, res) => {
  const { from, to, status } = req.query;
  const filters = {};
  if (status) filters.status = status;
  const dateMatch = buildDateMatch(from, to);
  if (dateMatch) filters.created_at = dateMatch;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`
  );

  const headers = [
    "order_id",
    "created_at",
    "status",
    "total",
    "user_id",
    "guest_id",
    "customer_email",
    "customer_name",
    "payment_status",
    "items_count",
    "delivery_method",
    "pickup_committed_date",
    "shipping_region",
    "shipping_city",
  ];
  res.write(headers.join(",") + "\n");

  const cursor = Order.find(filters).sort({ created_at: -1 }).lean().cursor();
  for await (const o of cursor) {
    const row = [
      o._id,
      o.created_at?.toISOString?.() || "",
      o.status,
      o.total,
      o.user_id || "",
      o.guest_id || "",
      o.customer?.email || "",
      o.customer?.fullName || "",
      o.payment?.status || "",
      o.items?.length || 0,
      o.delivery_method || "",
      o.pickup?.committed_date?.toISOString?.() || "",
      o.shipping?.region || "",
      o.shipping?.city || "",
    ].map(csvEscape);
    res.write(row.join(",") + "\n");
  }
  res.end();
});
