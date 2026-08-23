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

  // Simétrico a la regla de arriba: si un gerente no puede ASCENDER a nadie a
  // administrador, tampoco puede DEGRADAR a uno. Antes solo lo frenaba el
  // "debe quedar al menos un administrador", así que con dos admins activos un
  // gerente podía bajarle el rol a uno de ellos.
  if (target.role === ROLES.ADMIN && req.user.role !== ROLES.ADMIN) {
    throw new ForbiddenError("Solo un administrador puede cambiar el rol de otro administrador");
  }

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

  // Mismo criterio que updateUserRole: desactivar a un administrador es
  // equivalente a quitarle el acceso, así que solo otro admin puede hacerlo.
  if (target.role === ROLES.ADMIN && is_active === false && req.user.role !== ROLES.ADMIN) {
    throw new ForbiddenError("Solo un administrador puede desactivar a otro administrador");
  }

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
