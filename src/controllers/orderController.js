import mongoose from "mongoose";

import Order from "../models/Order.js";
import Product from "../models/Product.js";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { getRequestIdentity } from "../utils/ownership.js";
import { getStoreStatusData } from "./contentController.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { env } from "../config/env.js";
import { relayBus } from "../utils/relayBus.js";

import {
  createOrderFromCart as svcCreateFromCart,
  createOrderFromCustomBox as svcCreateFromCustomBox,
  cancelOrder as svcCancelOrder,
  deleteOrder as svcDeleteOrder,
  transitionOrderStatus as svcTransitionOrderStatus,
  payCash as svcPayCash,
  attachTransferReceipt as svcAttachTransferReceipt,
  findOrderForOwner,
  verifyGuestOrderAccess,
} from "../services/orderService.js";
import {
  retryPayment as svcRetryPayment,
} from "../services/paymentService.js";
import { notificarPedidoCreado } from "../services/notificacionesPedidoService.js";
import { uploadImage as svcUploadImage } from "../services/uploadService.js";
import { ROLES, PERMISSIONS, roleHasPermission, canRoleTransition } from "../utils/constants.js";

const buildActor = (reqUser, fallbackLabel = "cliente") => ({
  user_id: reqUser?.id || null,
  role: reqUser?.role || null,
  label: reqUser?.email || fallbackLabel,
});

/**
 * Estado destino permitido por rol. Fuente única: la matriz TRANSITION_PERMISSION
 * del relay (constants.js) — cada estado-destino exige un permiso. El relay:
 * cajera cobra (→paid), bodeguero prepara (→preparing/ready), cajera entrega
 * (→delivered), gerente/admin todo. (VALID_TRANSITIONS valida la legalidad from→to.)
 */
const canRoleSetStatus = (role, target) => canRoleTransition(role, target);

const sanitizeOrder = (order) => {
  if (!order) return null;
  if (typeof order.toJSON === "function") return order.toJSON();
  const clone = { ...order };
  delete clone.guest_token_hash;
  return clone;
};

/* ------------------------------ handlers --------------------------------- */

// La tienda online puede estar EN PAUSA (interruptor del panel): el checkout de
// clientes se bloquea (la venta presencial del WMS usa /admin/* y no pasa por aquí).
const assertTiendaAbierta = async () => {
  const st = await getStoreStatusData();
  if (st.paused) throw new ConflictError(st.message || "La tienda está temporalmente en pausa. Vuelve a intentarlo más tarde.");
};

export const createFromCart = asyncHandler(async (req, res) => {
  await assertTiendaAbierta();
  const identity = getRequestIdentity(req);
  if (!identity.userId && !identity.guestId) {
    throw new BadRequestError("Identidad requerida (login o x-guest-id)");
  }

  const { customer, shipping, delivery, payment, notes, couponCode } = req.body;

  const result = await svcCreateFromCart({
    identity,
    user: req.user,
    customer,
    shipping,
    delivery,
    payment,
    notes,
    couponCode,
  });

  // El correo "Recibimos tu pedido" no bloquea la creación: si el envío falla,
  // el pedido ya está creado, y tumbar la respuesta por eso deja al cliente sin
  // confirmación de algo que sí ocurrió.
  notificarPedidoCreado({ order: result.order }).catch(() => {});

  return res.status(201).json({
    success: true,
    data: {
      order: sanitizeOrder(result.order),
      guest_token: result.guestToken || undefined,
      coupon: result.couponInfo || undefined,
    },
  });
});

export const createFromCustomBox = asyncHandler(async (req, res) => {
  await assertTiendaAbierta();
  const identity = getRequestIdentity(req);
  if (!identity.userId && !identity.guestId) {
    throw new BadRequestError("Identidad requerida (login o x-guest-id)");
  }

  const { items, customer, shipping, payment, notes, couponCode } = req.body;

  const result = await svcCreateFromCustomBox({
    identity,
    user: req.user,
    items,
    customer,
    shipping,
    payment,
    notes,
    couponCode,
  });

  notificarPedidoCreado({ order: result.order }).catch(() => {});

  return res.status(201).json({
    success: true,
    data: {
      order: sanitizeOrder(result.order),
      guest_token: result.guestToken || undefined,
      coupon: result.couponInfo || undefined,
    },
  });
});

export const getMyOrders = asyncHandler(async (req, res) => {
  if (!req.user?.id) throw new ForbiddenError("Login requerido");

  const orders = await Order.find({ user_id: req.user.id })
    .sort({ created_at: -1 })
    .limit(100);

  return res.status(200).json({
    success: true,
    data: orders.map(sanitizeOrder),
  });
});

export const getOrderById = asyncHandler(async (req, res) => {
  // Admin puede ver cualquier orden sin verificar ownership
  if (req.user?.role === "admin") {
    const order = await Order.findById(req.params.id).select("-guest_token_hash").lean();
    if (!order) throw new BadRequestError("Orden no encontrada");
    return res.status(200).json({ success: true, data: order });
  }

  const identity = getRequestIdentity(req);
  identity.guestToken = req.query?.token || req.body?.guestToken || null;

  const order = await findOrderForOwner({
    orderId: req.params.id,
    identity,
    includeGuestToken: true,
  });

  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});

export const getGuestOrderById = asyncHandler(async (req, res) => {
  const order = await verifyGuestOrderAccess({
    orderId: req.params.id,
    token: req.query.token,
  });
  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});

export const cancelMyOrder = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  identity.guestToken = req.body?.guestToken || null;

  if (!identity.userId && !identity.guestId && !identity.guestToken) {
    throw new BadRequestError("Identidad requerida para cancelar la orden");
  }

  const order = await svcCancelOrder({
    orderId: req.params.id,
    reason: req.body?.reason,
    byAdmin: false,
    identity,
    by: buildActor(req.user, identity.guestId ? "invitado" : "cliente"),
  });

  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});

export const retryPayment = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  identity.guestToken = req.body?.guestToken || null;

  const order = await findOrderForOwner({
    orderId: req.params.id,
    identity,
    includeGuestToken: true,
  });

  const result = await svcRetryPayment({
    order,
    platform: req.body?.platform,
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
});

export const attachTransferReceipt = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  identity.guestToken = req.body?.guestToken || null;

  // Verifica que quien sube el comprobante sea el dueño de la orden.
  const owned = await findOrderForOwner({
    orderId: req.params.id,
    identity,
    includeGuestToken: true,
  });

  // El comprobante llega como URL (compat) o como archivo multipart (campo
  // "receipt"): el cliente no tiene products.manage para POST /uploads/image,
  // así que lo subimos aquí con el uploadService, tras validar ownership.
  let receiptUrl = req.body?.receipt_url || null;
  if (!receiptUrl && req.file) {
    // Pre-chequeos (los mismos del servicio) ANTES de subir el archivo, para
    // no dejar imágenes huérfanas en el storage si la orden no aplica.
    if (owned.payment?.method !== "transfer") {
      throw new BadRequestError(
        "El comprobante solo aplica a pagos por transferencia",
      );
    }
    if (owned.status !== "pending") {
      throw new ConflictError("La orden ya no está pendiente de pago");
    }
    const uploaded = await svcUploadImage({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
    });
    receiptUrl = uploaded.url;
  }
  if (!receiptUrl) {
    throw new BadRequestError(
      "Adjunta el comprobante (archivo 'receipt') o envía receipt_url",
    );
  }

  const order = await svcAttachTransferReceipt({
    orderId: req.params.id,
    receiptUrl,
  });

  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});

// Datos bancarios para pagar por transferencia (PÚBLICO): la tienda los
// muestra al confirmar la compra y en el detalle del pedido. Solo expone
// env.BANK_TRANSFER_INFO (multilínea) o null si no está configurada.
export const getTransferInfo = asyncHandler(async (_req, res) => {
  const info = String(env.BANK_TRANSFER_INFO || "").trim() || null;
  return res.status(200).json({ success: true, data: { info } });
});

/* ------------------------------- admin ----------------------------------- */

/**
 * Rango [00:00, 24:00) del día YYYY-MM-DD en America/Santiago, expresado en
 * instantes UTC. Calcula el offset real de Santiago para esa fecha (maneja
 * horario de verano) y arma el rango como Date UTC para consultar Mongo.
 */
const santiagoDayRange = (ymd) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return null;
  // Offset de Santiago a las 12:00 de ese día (evita bordes de DST).
  const probe = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    timeZoneName: "longOffset",
  })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value || "GMT-04:00";
  const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(parts);
  let offsetMin = 0;
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    offsetMin = sign * (Number(m[2]) * 60 + Number(m[3]));
  }
  // 00:00 local = (00:00 - offset) UTC.
  const start = new Date(`${ymd}T00:00:00Z`);
  start.setUTCMinutes(start.getUTCMinutes() - offsetMin);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

const santiagoTodayYMD = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export const adminListOrders = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.ORDERS_READ))
    throw new ForbiddenError("Permiso insuficiente");

  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  // Tope subido a 200 para vistas del WMS que paginan en bloques grandes
  // (calendario/listados). pagination.total usa countDocuments del MISMO filtro,
  // así que es exacto independientemente del limit.
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
  const status = req.query.status || null;
  const skip   = (page - 1) * limit;

  const filter = {};
  if (status) filter.status = status;

  // Filtro por método de entrega (delivery | pickup)
  const deliveryMethod = req.query.delivery_method || null;
  if (deliveryMethod === "delivery" || deliveryMethod === "pickup") {
    filter.delivery_method = deliveryMethod;
  }

  // Filtro por fecha comprometida de retiro (día completo, America/Santiago)
  // mongoose.trusted: requerido por sanitizeFilter para pasar operadores ($gte/$lt).
  const committedDate = req.query.committed_date || null;
  if (committedDate) {
    const range = santiagoDayRange(committedDate);
    if (range) {
      filter["pickup.committed_date"] = mongoose.trusted({
        $gte: range.start,
        $lt: range.end,
      });
    }
  }

  // Rango por fecha comprometida de retiro (committed_from / committed_to) — para
  // las vistas semanal/mensual del calendario de retiros.
  const committedFrom = req.query.committed_from || null;
  const committedTo = req.query.committed_to || null;
  if (!committedDate && (committedFrom || committedTo)) {
    const cf = {};
    if (committedFrom) {
      const r = santiagoDayRange(committedFrom);
      if (r) cf.$gte = r.start;
    }
    if (committedTo) {
      const r = santiagoDayRange(committedTo);
      if (r) cf.$lt = r.end;
    }
    if (Object.keys(cf).length) {
      filter["pickup.committed_date"] = mongoose.trusted(cf);
    }
  }

  // Rango por fecha de creación (from/to, inclusivo en ambos extremos por día)
  const from = req.query.from || null;
  const to = req.query.to || null;
  if (from || to) {
    const createdFilter = {};
    if (from) {
      const r = santiagoDayRange(from);
      if (r) createdFilter.$gte = r.start;
    }
    if (to) {
      const r = santiagoDayRange(to);
      if (r) createdFilter.$lt = r.end; // hasta el final del día "to"
    }
    if (Object.keys(createdFilter).length)
      filter.created_at = mongoose.trusted(createdFilter);
  }

  // Búsqueda por nombre o email del cliente (regex case-insensitive)
  const search = String(req.query.search || "").trim();
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = [
      { "customer.fullName": mongoose.trusted(rx) },
      { "customer.email": mongoose.trusted(rx) },
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      // Solo inclusiones (no mezclar con -guest_token_hash; ese campo ya es
      // select:false por schema). status_history/delivery_method/pickup/customer
      // van explícitos por contrato del WMS.
      .select(
        "status status_history delivery_method pickup customer assigned_to packing needs_review created_at total payment shipping items source coupon subtotal shipping_amount discount_amount notes user_id guest_id updated_at",
      )
      .lean(),
    Order.countDocuments(filter),
  ]);

  // Enriquecer cada ítem con la ubicación física y el código de barras del
  // producto (no se guardan en la orden): el picking necesita saber a qué rack
  // ir y qué escanear. Una sola query por todos los productos de la página.
  const productIds = [
    ...new Set(
      orders.flatMap((o) => (o.items || []).map((it) => String(it.product_id)).filter(Boolean)),
    ),
  ];
  if (productIds.length) {
    const products = await Product.find({ _id: mongoose.trusted({ $in: productIds }) })
      .select("location barcode")
      .lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    for (const o of orders) {
      for (const it of o.items || []) {
        const p = byId.get(String(it.product_id));
        if (p) {
          it.location = p.location || null;
          it.barcode = p.barcode || null;
        }
      }
    }
  }

  return res.json({
    success: true,
    data: {
      orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
});

/**
 * Tablero PÚBLICO de estado para clientes en la bodega (sin login).
 * GET /orders/board → { paid:[...], preparing:[...], ready:[...] }
 * Privacidad: solo número de pedido + primer nombre + fecha comprometida.
 */
export const ordersBoard = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    status: mongoose.trusted({ $in: ["paid", "preparing", "ready"] }),
  })
    .select("status customer.fullName pickup.committed_date created_at")
    .sort({ created_at: 1 })
    .limit(150)
    .lean();

  const fmt = (o) => ({
    number: "#" + String(o._id).slice(-6).toUpperCase(),
    name: String(o.customer?.fullName || "").trim().split(/\s+/)[0] || "Cliente",
    committed: o.pickup?.committed_date || null,
  });

  res.json({
    success: true,
    data: {
      paid: orders.filter((o) => o.status === "paid").map(fmt),
      preparing: orders.filter((o) => o.status === "preparing").map(fmt),
      ready: orders.filter((o) => o.status === "ready").map(fmt),
    },
  });
});

/**
 * Resumen de retiros en bodega para un día (default hoy, America/Santiago).
 * GET /orders/admin/pickup-summary?date=YYYY-MM-DD
 */
export const adminPickupSummary = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.ORDERS_READ))
    throw new ForbiddenError("Permiso insuficiente");

  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? req.query.date
      : santiagoTodayYMD();

  const range = santiagoDayRange(date);
  const dayFilter = {
    delivery_method: "pickup",
    "pickup.committed_date": mongoose.trusted({
      $gte: range.start,
      $lt: range.end,
    }),
  };

  const dayOrders = await Order.find(dayFilter)
    .sort({ created_at: 1 })
    .select("customer total status created_at pickup.committed_date")
    .lean();

  const by_status = {
    pending: 0,
    paid: 0,
    preparing: 0,
    ready: 0,
    delivered: 0,
    cancelled: 0,
  };
  for (const o of dayOrders) {
    if (by_status[o.status] !== undefined) by_status[o.status] += 1;
  }

  // Próximos 7 días con retiros comprometidos (incluye el día consultado).
  const weekStart = range.start;
  const weekEnd = new Date(range.start);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  const upcomingRaw = await Order.find({
    delivery_method: "pickup",
    status: mongoose.trusted({ $nin: ["cancelled"] }),
    "pickup.committed_date": mongoose.trusted({
      $gte: weekStart,
      $lt: weekEnd,
    }),
  })
    .select("pickup.committed_date")
    .lean();

  const upcomingMap = new Map();
  for (const o of upcomingRaw) {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(o.pickup.committed_date));
    upcomingMap.set(ymd, (upcomingMap.get(ymd) || 0) + 1);
  }
  const upcoming = [...upcomingMap.entries()]
    .map(([d, count]) => ({ date: d, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return res.json({
    success: true,
    data: {
      date,
      total_committed: dayOrders.length,
      by_status,
      upcoming,
      orders: dayOrders.map((o) => ({
        _id: o._id,
        customer: o.customer,
        total: o.total,
        status: o.status,
        created_at: o.created_at,
        committed_date: o.pickup?.committed_date || null,
      })),
    },
  });
});

/**
 * Conteo de retiros comprometidos por día en un rango (para el calendario).
 * GET /orders/admin/pickup-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export const adminPickupCalendar = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.ORDERS_READ))
    throw new ForbiddenError("Permiso insuficiente");

  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ""))
    ? req.query.from
    : santiagoTodayYMD();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ""))
    ? req.query.to
    : from;

  const start = santiagoDayRange(from).start;
  const end = santiagoDayRange(to).end;

  const rows = await Order.find({
    delivery_method: "pickup",
    status: mongoose.trusted({ $nin: ["cancelled"] }),
    "pickup.committed_date": mongoose.trusted({ $gte: start, $lt: end }),
  })
    .select("pickup.committed_date")
    .lean();

  const map = new Map();
  for (const o of rows) {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(o.pickup.committed_date));
    map.set(ymd, (map.get(ymd) || 0) + 1);
  }

  return res.json({
    success: true,
    data: { days: [...map.entries()].map(([date, count]) => ({ date, count })) },
  });
});

/**
 * Marca pagada EN EFECTIVO una orden cash_on_pickup registrando el monto
 * recibido y el vuelto. POST /orders/admin/:id/pay-cash { amount_received }.
 * Gate por permiso (cajero: orders.deliver) en la ruta.
 */
export const adminPayCash = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const amountReceived = req.body?.amount_received;

  // payCash decide solo: pending→paid (cobro adelantado) vs registrar el pago al
  // retiro (orden ya preparada). El estado de fulfillment lo mueve el cajero aparte.
  const order = await svcPayCash({
    orderId: id,
    amountReceived,
    by: buildActor(req.user, "operaciones"),
  });

  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});


export const adminCancelOrder = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.ORDERS_CANCEL))
    throw new ForbiddenError("Permiso insuficiente");

  const order = await svcCancelOrder({
    orderId: req.params.id,
    reason: req.body?.reason,
    byAdmin: true,
    by: buildActor(req.user, "bodega"),
  });

  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});

/** DELETE /orders/admin/:id — elimina el pedido (libera stock si no es terminal). */
export const adminDeleteOrder = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.ORDERS_CANCEL))
    throw new ForbiddenError("Permiso insuficiente");
  const result = await svcDeleteOrder({ orderId: req.params.id, by: buildActor(req.user, "bodega") });
  return res.status(200).json({ success: true, data: result });
});

// GET /orders/stream — SSE público: empuja un evento cada vez que cambia un
// pedido del relay (toma/cobro/aceptar/listo/entrega). La pantalla y la cola se
// refrescan al instante; el polling queda como respaldo.
export const ordersStream = (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n: conectado\n\n");
  const onChange = (p) => {
    try { res.write(`event: change\ndata: ${JSON.stringify(p || {})}\n\n`); } catch { /* cliente cerró */ }
  };
  relayBus.on("change", onChange);
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch { /* noop */ } }, 25000);
  req.on("close", () => { clearInterval(hb); relayBus.off("change", onChange); });
};

export const adminUpdateOrderStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, tracking_number, note } = req.body;

  // Control fino: el rol debe poder mover el pedido a ESE estado destino.
  if (!canRoleSetStatus(req.user?.role, status))
    throw new ForbiddenError("Tu rol no puede mover el pedido a ese estado");

  // Toda la lógica de transición vive en orderService:
  // - valida VALID_TRANSITIONS
  // - cancelled → cancelOrder (repone stock + revierte cupón + kardex)
  // - historial con atribución (quién/cuándo/nota) y timestamps shipped/delivered
  const order = await svcTransitionOrderStatus({
    orderId: id,
    newStatus: status,
    byAdmin: true,
    by: buildActor(req.user, "bodega"),
    note: note || (status === "cancelled" ? "Cancelado por bodega" : null),
    trackingNumber: tracking_number || null,
  });

  // El aviso al cliente (correo + push/in-app) ya no vive aquí: lo dispara el
  // servicio que persiste la transición (notificacionesPedidoService), así
  // avisa igual el picking, el webhook del courier y los demás caminos.

  return res.status(200).json({ success: true, data: sanitizeOrder(order) });
});
