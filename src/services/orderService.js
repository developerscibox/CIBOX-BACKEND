import crypto from "node:crypto";
import mongoose from "mongoose";

import Order from "../models/Order.js";
import Cart from "../models/Cart.js";
import Product from "../models/Product.js";
import Coupon from "../models/Coupon.js";
import Refund from "../models/Refund.js";
import CouponUsage from "../models/CouponUsage.js";
import StockMovement from "../models/StockMovement.js";
import TaxDocument from "../models/TaxDocument.js";

import {
  ORDER_STATUS,
  PAID_STATUSES,
  PAYMENT_STATUS,
  VALID_TRANSITIONS,
  puedeTransicionar,
  MOVEMENT_TYPES,
} from "../utils/constants.js";
import { withTransaction } from "../utils/transactions.js";
import { logger } from "../utils/logger.js";
import { emitRelayChange } from "../utils/relayBus.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { formatRut, isValidRut } from "../utils/rut.js";

import { calculateItemPricing } from "./pricingService.js";
import { allocateStockAtomic, commitPick, releaseAllocated, restoreStock, confirmReservation } from "./stockService.js";
import { planDeDespacho } from "../inventario/pick.js";
import {
  logOrderStockMovements,
  consumeBatchesFEFO,
  recomputeProductExpiry,
} from "./inventoryService.js";
import { emitDocumentForOrder } from "./siiService.js";

// Boleta (stub SII) best-effort: se emite tras CUALQUIER método de pago, no solo
// Webpay. Idempotente (siiService deduplica por orden+tipo) y nunca rompe el pago.
const emitBoletaBestEffort = async (order) => {
  if (!order) return;
  try {
    await emitDocumentForOrder(order, "boleta");
  } catch (err) {
    logger.warn({ orderId: String(order?._id || ""), err: err.message }, "boleta best-effort falló");
  }
};
import {
  validateCouponForUser,
  calculateCouponDiscount,
  applyCouponToOrder,
  revertCouponUsage,
  findCouponByCode,
  findFirstPurchaseAutoCoupon,
} from "./couponService.js";
import { quoteShippingForOrder } from "./shippingService.js";

import { addressOneLine } from "../config/brand.js";
/* ------------------------------ helpers ---------------------------------- */

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();

const normalizePhoneCL = (phone = "") => {
  let v = String(phone || "").replace(/[^\d+]/g, "");
  if (v.startsWith("56")) v = `+${v}`;
  if (!v.startsWith("+56") && v.length === 9 && v.startsWith("9"))
    v = `+56${v}`;
  return v;
};

const isValidEmailFormat = (e) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(e));

const isValidPhoneCL = (p) => /^\+569\d{8}$/.test(normalizePhoneCL(p));

// Dirección física de retiro. Fuente de verdad: config/brand.js.
const PICKUP_LOCATION = addressOneLine();

/**
 * Valida customer siempre y shipping solo cuando es retiro=delivery.
 * En pickup el shipping es opcional.
 */
const validateCustomerAndShipping = ({ customer, shipping, isPickup = false }) => {
  const errors = {};
  if (!String(customer?.fullName || "").trim())
    errors.fullName = "Nombre requerido";
  if (!isValidEmailFormat(customer?.email)) errors.email = "Email inválido";
  if (!isValidPhoneCL(customer?.phone)) errors.phone = "Teléfono inválido";
  if (!isValidRut(customer?.rut)) errors.rut = "RUT inválido";
  if (isPickup) return errors; // pickup: no exige dirección de despacho
  if (!String(shipping?.region || "").trim())
    errors.region = "Región requerida";
  if (!String(shipping?.city || "").trim()) errors.city = "Comuna requerida";
  if (String(shipping?.address || "").trim().length < 5)
    errors.address = "Dirección inválida";
  return errors;
};

/**
 * Hoy en America/Santiago como Date a las 00:00 (para comparar con la fecha
 * comprometida sin verse afectado por la zona del servidor).
 */
const santiagoTodayYMD = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // "YYYY-MM-DD"
};

/**
 * Resuelve y valida el bloque delivery del request.
 * - method "pickup": committed_date REQUERIDA, hoy o futura (America/Santiago).
 * - method "delivery" o ausente: comportamiento delivery (retrocompatible).
 * Devuelve { isPickup, committedDate (Date|null) }.
 */
const resolveDelivery = (delivery = {}) => {
  const method = String(delivery?.method || "delivery").toLowerCase();
  const isPickup = method === "pickup";

  if (!isPickup) return { isPickup: false, committedDate: null };

  const raw = String(delivery?.committed_date || "").trim();
  if (!raw) {
    throw new BadRequestError("Hay campos inválidos en el checkout", {
      committed_date: "Fecha de retiro requerida",
    });
  }

  // Tomar solo la parte YYYY-MM-DD (acepta ISO completo).
  const ymd = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new BadRequestError("Hay campos inválidos en el checkout", {
      committed_date: "Formato inválido (YYYY-MM-DD)",
    });
  }

  if (ymd < santiagoTodayYMD()) {
    throw new BadRequestError("Hay campos inválidos en el checkout", {
      committed_date: "La fecha de retiro debe ser hoy o futura",
    });
  }

  // Guardar como mediodía UTC del día comprometido para evitar que un offset
  // de zona empuje la fecha al día anterior/siguiente al mostrarla.
  const committedDate = new Date(`${ymd}T12:00:00.000Z`);
  return { isPickup: true, committedDate };
};

const buildCustomer = (raw = {}) => ({
  fullName: String(raw.fullName || "").trim(),
  email: normalizeEmail(raw.email),
  phone: normalizePhoneCL(raw.phone),
  rut: formatRut(raw.rut || ""),
});

const buildShipping = (raw = {}) => ({
  region: String(raw.region || "").trim(),
  city: String(raw.city || "").trim(),
  address: String(raw.address || "").trim(),
  addressLine2: String(raw.addressLine2 || "").trim() || null,
  reference: String(raw.reference || "").trim() || null,
});

const issueGuestToken = () => crypto.randomBytes(32).toString("hex");
const hashGuestToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const verifyGuestToken = (token, hash) => {
  if (!token || !hash) return false;
  const computed = hashGuestToken(token);
  const a = Buffer.from(computed);
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const isOrderOwner = ({ order, userId, guestId, guestToken }) => {
  if (userId && String(order.user_id) === String(userId)) return true;
  if (guestId && order.guest_id && String(order.guest_id) === String(guestId)) {
    return true;
  }
  if (guestToken && order.guest_token_hash) {
    return verifyGuestToken(guestToken, order.guest_token_hash);
  }
  return false;
};

/**
 * Agrega una entrada al historial de estados con atribución (quién/cuándo).
 * `by`: { user_id, role, label } — ej: { label: "webpay" } o datos del admin.
 */
const appendHistory = (order, status, { note = null, by = null } = {}) => {
  if (!Array.isArray(order.status_history)) order.status_history = [];
  order.status_history.push({
    status,
    changed_at: new Date(),
    note: note ? String(note).trim() : null,
    changed_by: {
      user_id: by?.user_id || null,
      role: by?.role || null,
      label: by?.label || "sistema",
    },
  });
  order.markModified("status_history");
};


/* ------------------------- recálculo server-side ------------------------- */

/**
 * Recalcula los items y subtotal desde Product (NO confía en cart.items).
 * Devuelve { items, subtotal, productsMap }.
 */
const rebuildItemsFromCart = async ({ cart, user, session }) => {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    throw new BadRequestError("El carrito está vacío");
  }

  const productIds = [...new Set(cart.items.map((i) => String(i.product_id)))];

  // Una sola query en vez de N findById (evita N+1)
  const products = await Product.find({
    _id: mongoose.trusted({ $in: productIds }),
  })
    .session(session || null)
    .lean();

  // Cargar productos hijos de las cajas por separado (también en una query)
  const boxProductIds = [
    ...new Set(
      products
        .filter((p) => p.product_type === "box")
        .flatMap((p) => (p.box_items || []).map((bi) => String(bi.product_id)))
        .filter(Boolean)
    ),
  ];

  const childProductsRaw = boxProductIds.length
    ? await Product.find({ _id: mongoose.trusted({ $in: boxProductIds }) })
        .select("name pricing brand")
        .session(session || null)
        .lean()
    : [];

  const childMap = new Map(
    childProductsRaw.map((p) => [String(p._id), p])
  );

  const map = new Map(products.map((p) => [String(p._id), p]));

  const rebuiltItems = [];
  let subtotal = 0;

  for (const cartItem of cart.items) {
    const product = map.get(String(cartItem.product_id));
    if (!product) throw new ConflictError(`Producto no encontrado: ${cartItem.name}`);
    if (!product.is_active) throw new ConflictError(`Producto inactivo: ${product.name}`);

    const tiers = product?.pricing?.tiers || [];
    const pricing = calculateItemPricing({
      tiers,
      quantity: Number(cartItem.quantity || 0),
      product,
      user,
    });

    // Liberar PRIMERO el reserved de esta línea (Fase 1) y LUEGO comprometer
    // (allocated), para que la asignación no choque con la propia reserva del
    // carrito (si no, un carrito que reservó todo el stock no podría comprarlo).
    // Defensivo: un fallo al cerrar la reserva no debe abortar la orden.
    try {
      await confirmReservation(
        { cartId: cart?._id, productId: product._id, quantity: pricing.quantity },
        session,
      );
    } catch (e) { /* el job de expiración / reconciliación lo corrige */ }

    await allocateStockAtomic(
      { productId: product._id, quantity: pricing.quantity },
      session,
    );

    const isBox = product.product_type === "box";
    const boxItemsData = isBox && Array.isArray(product.box_items)
      ? product.box_items.map((bi) => {
          const child = childMap.get(String(bi.product_id));
          const childPrice = child?.pricing?.tiers?.[0]?.price || 0;
          return {
            product_id: bi.product_id,
            name: child?.name || "Producto",
            quantity: bi.quantity,
            unit_price: childPrice,
            subtotal: childPrice * bi.quantity,
          };
        })
      : [];

    rebuiltItems.push({
      product_id: product._id,
      name: product.name,
      quantity: pricing.quantity,
      price: pricing.unit_price,
      original_price: pricing.original_unit_price,
      tier_label: pricing.tier_label,
      discount_applied: pricing.discount_applied,
      discount_percent: pricing.discount_percent,
      discount_amount_per_unit: pricing.discount_amount_per_unit,
      discount_source: pricing.discount_source,
      subtotal: pricing.subtotal,
      original_subtotal: pricing.original_subtotal,
      product_type: isBox ? "box" : "simple",
      box_items: boxItemsData,
      weight: product.weight || { value: 0, unit: "g" },
      dimensions: product.dimensions || { length: 0, width: 0, height: 0, unit: "cm" },
    });

    subtotal += pricing.subtotal;
  }

  return { items: rebuiltItems, subtotal, productsMap: map };
};
const rebuildItemsFromCustomBox = async ({ rawItems, user, session }) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new BadRequestError("La caja personalizada está vacía");
  }

  const productIds = [...new Set(rawItems.map((i) => String(i.product_id)))];
  // Una sola query en vez de N findById (evita N+1)
  const products = await Product.find({
    _id: mongoose.trusted({ $in: productIds }),
  })
    .session(session || null)
    .lean();

  const map = new Map(products.map((p) => [String(p._id), p]));

  const rebuiltItems = [];
  let subtotal = 0;

  for (const raw of rawItems) {
    const product = map.get(String(raw.product_id));
    if (!product) throw new ConflictError(`Producto no encontrado`);
    if (!product.is_active)
      throw new ConflictError(`Producto inactivo: ${product.name}`);

    const pricing = calculateItemPricing({
      tiers: product.pricing?.tiers || [],
      quantity: Number(raw.quantity || 0),
      product,
      user,
    });

    await allocateStockAtomic(
      { productId: product._id, quantity: pricing.quantity },
      session,
    );

    rebuiltItems.push({
      product_id: product._id,
      name: product.name,
      quantity: pricing.quantity,
      price: pricing.unit_price,
      original_price: pricing.original_unit_price,
      tier_label: pricing.tier_label,
      discount_applied: pricing.discount_applied,
      discount_percent: pricing.discount_percent,
      discount_amount_per_unit: pricing.discount_amount_per_unit,
      discount_source: pricing.discount_source,
      subtotal: pricing.subtotal,
      original_subtotal: pricing.original_subtotal,
      weight: product.weight || { value: 0, unit: "g" },
      dimensions: product.dimensions || {
        length: 0,
        width: 0,
        height: 0,
        unit: "cm",
      },
    });

    subtotal += pricing.subtotal;
  }

  return { items: rebuiltItems, subtotal, productsMap: map };
};

/* -------------------------- cotización + cupón --------------------------- */

const computeOrderTotals = ({ subtotal, shippingAmount, discountAmount }) => {
  const sub = Math.max(0, Math.round(Number(subtotal || 0)));
  const ship = Math.max(0, Math.round(Number(shippingAmount || 0)));
  const disc = Math.max(0, Math.round(Number(discountAmount || 0)));
  const cappedDisc = Math.min(disc, sub);
  const total = sub + ship - cappedDisc;
  return {
    subtotal: sub,
    shipping_amount: ship,
    discount_amount: cappedDisc,
    total: Math.max(0, total),
  };
};

const resolveShippingAmount = ({ items, shipping }) => {
  const orderLike = { items, shipping };
  const quote = quoteShippingForOrder(orderLike);
  return {
    amount: Number(quote.selected?.amount || 0),
    service_name: quote.selected?.service_name || null,
    service_code: quote.selected?.service_code || null,
    carrier: quote.selected?.carrier || "blueexpress_manual",
  };
};

const resolveCouponDiscount = async ({
  couponCode,
  subtotal,
  userId,
  guestId,
  session,
}) => {
  let coupon = null;
  let autoApplied = false;

  if (couponCode) {
    coupon = await findCouponByCode(couponCode);
  } else if (userId) {
    coupon = await findFirstPurchaseAutoCoupon();
    autoApplied = Boolean(coupon);
  }

  if (!coupon) {
    return {
      coupon: null,
      discount: 0,
      info: couponCode
        ? { valid: false, message: "Cupón no encontrado" }
        : null,
    };
  }

  const validation = await validateCouponForUser({
    coupon,
    userId,
    subtotal,
  });

  if (!validation.valid) {
    return {
      coupon: null,
      discount: 0,
      info: couponCode ? validation : null,
    };
  }

  const discount = calculateCouponDiscount({ coupon, subtotal });

  return {
    coupon,
    discount,
    info: {
      valid: true,
      discount_preview: discount,
      code: coupon.code,
      auto_applied: autoApplied,
    },
  };
};

/* ----------------------------- create flow ------------------------------- */

const buildOrderPayload = ({
  identity,
  items,
  totals,
  customer,
  shipping,
  payment,
  coupon,
  notes,
  source,
  guestTokenHash,
  deliveryMethod = "delivery",
  pickup = null,
}) => ({
  user_id: identity.userId || null,
  guest_id: identity.userId ? null : identity.guestId || null,
  guest_token_hash: identity.userId ? null : guestTokenHash,
  items,
  customer,
  delivery_method: deliveryMethod,
  ...(deliveryMethod === "pickup"
    ? {
        pickup: {
          committed_date: pickup?.committed_date || null,
          location: pickup?.location || PICKUP_LOCATION,
          picked_up_at: null,
        },
      }
    : {}),
  shipping: {
    ...shipping,
    amount: totals.shipping_amount,
    carrier: shipping.carrier || "blueexpress_manual",
    service_name: shipping.service_name || null,
    service_code: shipping.service_code || null,
    tracking_number: null,
    shipment_status: null,
    label_url: null,
  },
  payment: {
    method: payment?.method || "webpay",
    platform: payment?.platform || "web",
    status: PAYMENT_STATUS.PENDING,
    transaction_id: null,
    token: null,
    buy_order: null,
    session_id: null,
    amount: totals.total,
    authorization_code: null,
    response_code: null,
    transaction_date: null,
    webhook_processed_at: null,
  },
  coupon: {
    code: coupon?.code || null,
    coupon_id: coupon?._id || null,
    discount_amount: totals.discount_amount,
  },
  subtotal: totals.subtotal,
  shipping_amount: totals.shipping_amount,
  discount_amount: totals.discount_amount,
  total: totals.total,
  status: ORDER_STATUS.PENDING,
  status_history: [
    {
      status: ORDER_STATUS.PENDING,
      changed_at: new Date(),
      note: "Orden creada",
      changed_by: {
        user_id: identity.userId || null,
        role: identity.userId ? "customer" : null,
        label: identity.userId ? "cliente" : "invitado",
      },
    },
  ],
  source,
  notes: String(notes || "").trim() || null,
});

/**
 * Crea una orden desde el carrito (transaccional).
 */
export const createOrderFromCart = async ({
  identity,
  user,
  customer: rawCustomer,
  shipping: rawShipping,
  delivery,
  payment,
  notes,
  couponCode,
}) => {
  const { isPickup, committedDate } = resolveDelivery(delivery);

  const customer = buildCustomer(rawCustomer);
  const shipping = buildShipping(rawShipping);

  const errors = validateCustomerAndShipping({ customer, shipping, isPickup });
  if (Object.keys(errors).length > 0) {
    throw new BadRequestError("Hay campos inválidos en el checkout", errors);
  }

  if (!identity.userId && !identity.guestId) {
    throw new BadRequestError("Identidad requerida (login o x-guest-id)");
  }

  const result = await withTransaction(async (session) => {
    const cartFilter = identity.userId
      ? { user_id: identity.userId, status: "active" }
      : { guest_id: identity.guestId, status: "active" };

    const cart = await Cart.findOne(cartFilter).session(session);
    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
      throw new BadRequestError("El carrito está vacío");
    }

    const { items, subtotal } = await rebuildItemsFromCart({
      cart,
      user,
      session,
    });

    // Pickup: sin cotización de envío. shipping_amount=0, carrier pickup_in_store.
    const shippingResolved = isPickup
      ? {
          amount: 0,
          service_name: null,
          service_code: null,
          carrier: "pickup_in_store",
        }
      : resolveShippingAmount({ items, shipping });
    const shippingAmount = shippingResolved.amount;

    const couponResolved = await resolveCouponDiscount({
      couponCode,
      subtotal,
      userId: identity.userId,
      guestId: identity.guestId,
      session,
    });

    const totals = computeOrderTotals({
      subtotal,
      shippingAmount,
      discountAmount: couponResolved.discount,
    });

    const guestToken = identity.userId ? null : issueGuestToken();
    const guestTokenHash = guestToken ? hashGuestToken(guestToken) : null;

    const payload = buildOrderPayload({
      identity,
      items,
      totals,
      customer,
      shipping: {
        ...shipping,
        carrier: shippingResolved.carrier,
        service_name: shippingResolved.service_name,
        service_code: shippingResolved.service_code,
      },
      payment,
      coupon: couponResolved.coupon,
      notes,
      source: "cart",
      guestTokenHash,
      deliveryMethod: isPickup ? "pickup" : "delivery",
      pickup: isPickup
        ? { committed_date: committedDate, location: PICKUP_LOCATION }
        : null,
    });

    const [order] = await Order.create([payload], { session });

    // Fase 4: el físico NO se descuenta al crear (solo se COMPROMETE: allocated).
    // El kardex de venta se registra en el pick (commitOrderPick), no aquí.

    cart.status = "converted";
    await cart.save({ session });

    return { order, guestToken, couponInfo: couponResolved.info };
  });

  return result;
};

/**
 * Crea una orden desde una "custom box" (lista de items provista).
 */
export const createOrderFromCustomBox = async ({
  identity,
  user,
  items: rawItems,
  customer: rawCustomer,
  shipping: rawShipping,
  payment,
  notes,
  couponCode,
}) => {
  const customer = buildCustomer(rawCustomer);
  const shipping = buildShipping(rawShipping);

  const errors = validateCustomerAndShipping({ customer, shipping });
  if (Object.keys(errors).length > 0) {
    throw new BadRequestError("Hay campos inválidos en el checkout", errors);
  }

  if (!identity.userId && !identity.guestId) {
    throw new BadRequestError("Identidad requerida (login o x-guest-id)");
  }

  const result = await withTransaction(async (session) => {
    const { items, subtotal } = await rebuildItemsFromCustomBox({
      rawItems,
      user,
      session,
    });

    const shippingResolved = resolveShippingAmount({ items, shipping });
    const shippingAmount = shippingResolved.amount;

    const couponResolved = await resolveCouponDiscount({
      couponCode,
      subtotal,
      userId: identity.userId,
      guestId: identity.guestId,
      session,
    });

    const totals = computeOrderTotals({
      subtotal,
      shippingAmount,
      discountAmount: couponResolved.discount,
    });

    const guestToken = identity.userId ? null : issueGuestToken();
    const guestTokenHash = guestToken ? hashGuestToken(guestToken) : null;

    const payload = buildOrderPayload({
      identity,
      items,
      totals,
      customer,
      shipping: {
        ...shipping,
        carrier: shippingResolved.carrier,
        service_name: shippingResolved.service_name,
        service_code: shippingResolved.service_code,
      },
      payment,
      coupon: couponResolved.coupon,
      notes,
      source: "custom_box",
      guestTokenHash,
    });

    const [order] = await Order.create([payload], { session });

    // Fase 4: el físico NO se descuenta al crear (solo se COMPROMETE: allocated).
    // El kardex de venta se registra en el pick (commitOrderPick), no aquí.

    return { order, guestToken, couponInfo: couponResolved.info };
  });

  return result;
};

/* ---------------------- finalización + transiciones ----------------------- */

/**
 * Llamado tras la confirmación de pago. IDEMPOTENTE:
 * - Si ya tiene webhook_processed_at, retorna sin hacer nada.
 * - Descuenta stock atómicamente, aplica cupón (si corresponde),
 *   marca status=paid y setea webhook_processed_at.
 */
export const finalizePaidOrder = async (orderId) => {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId)
      .select("+guest_token_hash")
      .session(session);

    if (!order) throw new NotFoundError("Orden no encontrada");

    if (
      order.payment?.webhook_processed_at ||
      PAID_STATUSES.includes(order.status)
    ) {
      logger.warn(
        { orderId: String(order._id) },
        "finalizePaidOrder: ya procesado",
      );
      return order;
    }

    // Aplicar cupón si lo había
    if (order.coupon?.coupon_id && Number(order.coupon?.discount_amount) > 0) {
      const couponDoc = await Coupon.findById(order.coupon.coupon_id).session(
        session,
      );

      if (couponDoc) {
        await applyCouponToOrder(
          {
            coupon: couponDoc,
            userId: order.user_id,
            guestId: order.guest_id,
            orderId: order._id,
            discountAmount: order.coupon.discount_amount,
          },
          session,
        );
      }
    }

    order.status = ORDER_STATUS.PAID;
    order.payment.status = PAYMENT_STATUS.APPROVED;
    order.payment.webhook_processed_at = new Date();
    order.paid_at = new Date();
    appendHistory(order, ORDER_STATUS.PAID, {
      note: "Pago confirmado",
      by: { label: "webpay" },
    });

    await order.save({ session });

    logger.info(
      { orderId: String(order._id), total: order.total },
      "orden finalizada como pagada",
    );

    return order;
  });
};
/**
 * Marca una orden como pagada por el ADMIN (transfer / cash_on_pickup).
 * Camino simple, desacoplado de webpay: NO toca payment.token/buy_order ni
 * webhook_processed_at. Aplica cupón si lo había, setea paid_at y registra
 * status_history PENDING→PAID. IDEMPOTENTE: si ya está pagada, no hace nada.
 *
 * `cash`: { amount_received } — solo para pago en efectivo. Si llega, valida
 * que amount_received >= total, calcula el vuelto y lo guarda en
 * payment.amount_received / payment.change, y deja la nota del cuadre de caja.
 */
export const markAsPaid = async ({
  orderId,
  by = null,
  note = null,
  cash = null,
} = {}) => {
  const paid = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new NotFoundError("Orden no encontrada");

    if (PAID_STATUSES.includes(order.status)) {
      logger.warn({ orderId: String(order._id) }, "markAsPaid: ya pagada");
      return order;
    }

    const allowed = VALID_TRANSITIONS[order.status] || [];
    if (!allowed.includes(ORDER_STATUS.PAID)) {
      throw new ConflictError(
        `No se puede marcar como pagada una orden en estado "${order.status}"`,
      );
    }

    // Cuadre de caja: solo aplica al método efectivo y cuando llega el monto.
    let cashNote = null;
    if (cash && cash.amount_received != null) {
      if (order.payment?.method !== "cash_on_pickup") {
        throw new BadRequestError(
          "El cuadre de caja solo aplica a pagos en efectivo",
        );
      }
      const received = Math.round(Number(cash.amount_received));
      if (!Number.isFinite(received) || received < 0) {
        throw new BadRequestError("Monto recibido inválido");
      }
      const total = Number(order.total || 0);
      if (received < total) {
        throw new BadRequestError(
          `El monto recibido ($${received}) es menor al total ($${total})`,
        );
      }
      const change = received - total;
      order.payment.amount_received = received;
      order.payment.change = change;
      cashNote = `Efectivo: recibido $${received}, vuelto $${change}`;
    }

    // Aplicar cupón si lo había (mismo criterio que finalizePaidOrder).
    if (order.coupon?.coupon_id && Number(order.coupon?.discount_amount) > 0) {
      const couponDoc = await Coupon.findById(order.coupon.coupon_id).session(
        session,
      );
      if (couponDoc) {
        await applyCouponToOrder(
          {
            coupon: couponDoc,
            userId: order.user_id,
            guestId: order.guest_id,
            orderId: order._id,
            discountAmount: order.coupon.discount_amount,
          },
          session,
        );
      }
    }

    order.status = ORDER_STATUS.PAID;
    order.payment.status = PAYMENT_STATUS.APPROVED;
    order.paid_at = new Date();
    appendHistory(order, ORDER_STATUS.PAID, {
      note: cashNote || note || "Pago confirmado por admin",
      by: by || { label: "admin" },
    });

    await order.save({ session });

    logger.info(
      { orderId: String(order._id), method: order.payment?.method },
      "orden marcada como pagada (admin)",
    );
    return order;
  });
  await emitBoletaBestEffort(paid);
  return paid;
};

/**
 * Marca pagada EN EFECTIVO una orden cash_on_pickup, registrando el monto
 * recibido y el vuelto. Reusa markAsPaid (no rompe transfer/webpay).
 */
export const markAsPaidCash = async ({
  orderId,
  amountReceived,
  by = null,
} = {}) =>
  markAsPaid({ orderId, by, cash: { amount_received: amountReceived } });

/**
 * Cobra en efectivo una orden cash_on_pickup AL MOMENTO DEL RETIRO. La orden ya
 * fue preparada (preparing/ready): registra el monto recibido y el vuelto y deja
 * payment.status=approved + paid_at SIN tocar order.status (el cajero marca la
 * orden "retirada"/delivered aparte). Idempotente si ya estaba cobrada.
 */
export const collectCashAtPickup = async ({ orderId, amountReceived, by = null }) => {
  const paid = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new NotFoundError("Orden no encontrada");
    if (order.payment?.method !== "cash_on_pickup") {
      throw new BadRequestError("Solo aplica a pagos en efectivo al retirar");
    }
    if (order.payment?.status === PAYMENT_STATUS.APPROVED) {
      return order; // idempotente: ya cobrada
    }
    const received = Math.round(Number(amountReceived));
    const total = Number(order.total || 0);
    if (!Number.isFinite(received) || received < total) {
      throw new BadRequestError(
        `El monto recibido ($${received}) es menor al total ($${total})`,
      );
    }
    order.payment.amount_received = received;
    order.payment.change = received - total;
    order.payment.status = PAYMENT_STATUS.APPROVED;
    order.paid_at = new Date();
    appendHistory(order, order.status, {
      note: `Pago en efectivo registrado: recibido $${received}, vuelto $${received - total}`,
      by: by || { label: "operaciones" },
    });
    await order.save({ session });
    logger.info(
      { orderId: String(order._id), received, change: received - total },
      "efectivo cobrado al retiro",
    );
    return order;
  });
  await emitBoletaBestEffort(paid);
  return paid;
};

/**
 * Cobro en efectivo unificado para el panel. Si la orden sigue pending (cobro
 * por adelantado / venta presencial) hace pending→paid; si ya fue preparada
 * (BOPIS, cobro al retirar) solo registra el pago sin mover el fulfillment.
 */
export const payCash = async ({ orderId, amountReceived, by = null }) => {
  const order = await Order.findById(orderId).select("status").lean();
  if (!order) throw new NotFoundError("Orden no encontrada");
  if (order.status === ORDER_STATUS.PENDING) {
    return markAsPaid({ orderId, by, cash: { amount_received: amountReceived } });
  }
  return collectCashAtPickup({ orderId, amountReceived, by });
};

/**
 * Adjunta el comprobante de una transferencia manual a una orden pendiente.
 * La verificación de propiedad (cliente/invitado dueño) se hace en el controller.
 * El admin luego revisa el comprobante y marca la orden pagada (markAsPaid).
 */
export const attachTransferReceipt = async ({ orderId, receiptUrl }) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Orden no encontrada");
  if (order.payment?.method !== "transfer") {
    throw new BadRequestError(
      "El comprobante solo aplica a pagos por transferencia",
    );
  }
  if (order.status !== ORDER_STATUS.PENDING) {
    throw new ConflictError("La orden ya no está pendiente de pago");
  }
  order.payment.transfer_receipt_url = receiptUrl;
  order.payment.transfer_receipt_uploaded_at = new Date();
  await order.save();
  logger.info(
    { orderId: String(order._id) },
    "comprobante de transferencia adjuntado",
  );
  return order;
};

/**
 * Elimina un pedido (admin). Si el pedido aún retiene stock (estado NO terminal),
 * primero se cancela —liberando/restaurando stock y dejando el kardex— y luego se
 * borra el documento. Útil para limpiar pedidos de prueba o erróneos.
 */
export const deleteOrder = async ({ orderId, by = null }) => {
  if (!mongoose.isValidObjectId(orderId)) throw new NotFoundError("Pedido no encontrado");
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new NotFoundError("Pedido no encontrado");

    // Proteger la contabilidad: no borrar si tiene un documento tributario REAL
    // (no stub, no anulado) emitido. Las boletas de prueba (stub) sí se limpian.
    const emitted = await TaxDocument.findOne({
      order_id: order._id,
      status: mongoose.trusted({ $ne: "voided" }),
      stub: mongoose.trusted({ $ne: true }),
    }).session(session).lean();
    if (emitted) {
      throw new ConflictError(
        "El pedido tiene una boleta/factura emitida. Anúlala antes de eliminar el pedido.",
      );
    }

    // Reponer/liberar el stock que el pedido aún retenga, para que eliminarlo sea
    // "como si nunca hubiera existido" (misma mecánica idempotente que cancelar).
    if (!order.stock_restored) {
      if (order.stock_committed) {
        // El físico ya salió en el pick → reponer físico.
        for (const item of order.items) {
          if (!item.product_id) continue;
          await restoreStock({ productId: item.product_id, quantity: item.quantity }, session);
        }
      } else {
        // Aún comprometido (sin pick) → liberar allocated.
        for (const item of order.items) {
          if (!item.product_id) continue;
          await releaseAllocated({ productId: item.product_id, qty: item.quantity }, session);
        }
      }
    }
    if (PAID_STATUSES.includes(order.status)) {
      await revertCouponUsage({ orderId: order._id }, session);
    }

    // Limpiar referencias para no dejar huérfanos y borrar el pedido (misma tx).
    await Refund.deleteMany({ order_id: order._id }).session(session);
    await CouponUsage.deleteMany({ order_id: order._id }).session(session);
    await StockMovement.deleteMany({ order_id: order._id }).session(session);
    await TaxDocument.deleteMany({ order_id: order._id }).session(session);
    await Order.deleteOne({ _id: order._id }).session(session);

    logger.info({ orderId: String(order._id), status: order.status }, "pedido eliminado (stock repuesto, refs limpiadas)");
    return { _id: String(order._id), deleted: true };
  });
};

/**
 * Cancela una orden: si estaba paid, repone stock y revierte cupón.
 */
export const cancelOrder = async ({
  orderId,
  reason,
  byAdmin = false,
  identity = {},
  by = null,
  movementType = MOVEMENT_TYPES.CANCELLATION,
}) => {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId)
      .select("+guest_token_hash")
      .session(session);
    if (!order) throw new NotFoundError("Orden no encontrada");

    if (!byAdmin) {
      const owner = isOrderOwner({
        order,
        userId: identity.userId,
        guestId: identity.guestId,
        guestToken: identity.guestToken,
      });
      if (!owner)
        throw new ForbiddenError("No autorizado para cancelar esta orden");
    }

    const allowedFromCurrent = VALID_TRANSITIONS[order.status] || [];
    if (!allowedFromCurrent.includes(ORDER_STATUS.CANCELLED)) {
      throw new ConflictError(
        `No se puede cancelar una orden en estado "${order.status}"`,
      );
    }

    const wasPaid = PAID_STATUSES.includes(order.status);

    // El stock se descuenta al CREAR la orden (pending incluido), por lo que
    // SIEMPRE debe reponerse al cancelar — antes solo se reponía si estaba
    // pagada y las cancelaciones de órdenes pending fugaban stock.
    // Idempotente vía stock_restored.
    if (!order.stock_restored) {
      if (order.stock_committed) {
        // El físico ya salió en el pick: reponer físico + kardex.
        const stockAfterMap = new Map();
        for (const item of order.items) {
          if (!item.product_id) continue;
          const restored = await restoreStock(
            { productId: item.product_id, quantity: item.quantity },
            session,
          );
          if (restored) stockAfterMap.set(String(item.product_id), restored.stock);
        }
        await logOrderStockMovements(
          {
            order,
            type: movementType,
            sign: 1,
            reason: String(reason || "").trim() || "Cancelación de orden",
            by: by || { label: byAdmin ? "admin" : "cliente" },
            stockAfterMap,
          },
          session,
        );
      } else {
        // Aún comprometido (sin pick): liberar allocated. No hubo movimiento
        // físico, así que NO se registra kardex (nada salió de bodega).
        for (const item of order.items) {
          if (!item.product_id) continue;
          await releaseAllocated(
            { productId: item.product_id, qty: item.quantity },
            session,
          );
        }
      }
      order.stock_restored = true;
    }

    if (wasPaid) {
      await revertCouponUsage({ orderId: order._id }, session);
    }

    order.status = ORDER_STATUS.CANCELLED;
    order.payment.status = PAYMENT_STATUS.REJECTED;
    order.cancelled_at = new Date();
    order.cancellation_reason = String(reason || "").trim() || null;
    appendHistory(order, ORDER_STATUS.CANCELLED, {
      note: order.cancellation_reason,
      by: by || { label: byAdmin ? "admin" : "cliente" },
    });

    await order.save({ session });

    logger.info(
      { orderId: String(order._id), wasPaid, byAdmin },
      "orden cancelada (stock repuesto)",
    );
    return order;
  });
};

/**
 * Reembolsa una orden (PAID/DELIVERED→REFUNDED): repone stock y revierte cupón
 * con la MISMA mecánica idempotente de cancelOrder. Kardex con type=REFUND y
 * sign=+1; setea stock_restored, payment.status=refunded y status=REFUNDED.
 */
export const refundOrder = async ({
  orderId,
  reason,
  byAdmin = false,
  by = null,
} = {}) => {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId)
      .select("+guest_token_hash")
      .session(session);
    if (!order) throw new NotFoundError("Orden no encontrada");

    const allowedFromCurrent = VALID_TRANSITIONS[order.status] || [];
    if (!allowedFromCurrent.includes(ORDER_STATUS.REFUNDED)) {
      throw new ConflictError(
        `No se puede reembolsar una orden en estado "${order.status}"`,
      );
    }

    const hadCoupon =
      Boolean(order.coupon?.coupon_id) &&
      Number(order.coupon?.discount_amount) > 0;

    // Reposición idempotente vía stock_restored (igual que cancelOrder): si el
    // físico ya salió (pick), repone físico + kardex; si solo estaba comprometido,
    // libera allocated sin kardex.
    if (!order.stock_restored) {
      if (order.stock_committed) {
        const stockAfterMap = new Map();
        for (const item of order.items) {
          if (!item.product_id) continue;
          const restored = await restoreStock(
            { productId: item.product_id, quantity: item.quantity },
            session,
          );
          if (restored) stockAfterMap.set(String(item.product_id), restored.stock);
        }
        await logOrderStockMovements(
          {
            order,
            type: MOVEMENT_TYPES.REFUND,
            sign: 1,
            reason: String(reason || "").trim() || "Reembolso de orden",
            by: by || { label: byAdmin ? "admin" : "cliente" },
            stockAfterMap,
          },
          session,
        );
      } else {
        for (const item of order.items) {
          if (!item.product_id) continue;
          await releaseAllocated(
            { productId: item.product_id, qty: item.quantity },
            session,
          );
        }
      }
      order.stock_restored = true;
    }

    if (hadCoupon) {
      await revertCouponUsage({ orderId: order._id }, session);
    }

    order.status = ORDER_STATUS.REFUNDED;
    order.payment.status = PAYMENT_STATUS.REFUNDED;
    appendHistory(order, ORDER_STATUS.REFUNDED, {
      note: String(reason || "").trim() || null,
      by: by || { label: byAdmin ? "admin" : "cliente" },
    });

    await order.save({ session });

    logger.info(
      { orderId: String(order._id), byAdmin },
      "orden reembolsada (stock repuesto)",
    );
    return order;
  });
};

/**
 * Transición genérica de estado, validada por la máquina de estados
 * (pedidos/estados.js). Registra SIEMPRE quién y cuándo en status_history.
 */
/**
 * Confirma el pick de una orden (preparing→ready): el físico SALE de bodega.
 * Descuenta stock de cada ítem (commitPick), registra el kardex de venta y marca
 * stock_committed. El físico baja AQUÍ, no en el checkout (Fase 4). Idempotente.
 */
export const commitOrderPick = async ({
  orderId,
  targetStatus = ORDER_STATUS.READY,
  by = null,
  note = null,
  trackingNumber = null,
}) => {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new NotFoundError("Orden no encontrada");

    // El físico sale UNA sola vez (idempotente vía stock_committed).
    if (!order.stock_committed) {
      const stockAfterMap = new Map();
      const touchedProductIds = new Set();
      // Plan de despacho: cuánto sale del físico y cuánto solo se libera de lo
      // reservado. Los faltantes reportados al preparar YA descontaron su parte
      // del físico (registrarFaltante → adjustStock), así que descontarlos otra
      // vez aquí bajaría el stock DOS VECES. Lógica pura en inventario/pick.js.
      const plan = planDeDespacho(order.items, order.faltantes);
      const planPorProducto = new Map(plan.map((p) => [p.product_id, p]));
      for (const item of order.items) {
        if (!item.product_id) continue;
        const pid = String(item.product_id);
        const { real, faltante: faltan } = planPorProducto.get(pid) || {
          real: Number(item.quantity || 0),
          faltante: 0,
        };
        let updated = null;
        if (real > 0) {
          updated = await commitPick({ productId: item.product_id, quantity: real }, session);
        }
        if (faltan > 0) {
          // El físico faltante ya se ajustó al reportarlo; aquí solo se libera lo comprometido.
          updated = (await releaseAllocated({ productId: item.product_id, qty: faltan }, session)) || updated;
        }
        if (updated) stockAfterMap.set(String(item.product_id), updated.stock);
        // Capa ADITIVA de lotes (best-effort): consume FEFO por lote y anota la
        // trazabilidad en item.batches. JAMÁS bloquea ni revierte el pick — si la
        // capa de lotes falla, se loguea y se continúa (stock es la verdad).
        try {
          const consumed = await consumeBatchesFEFO(
            { productId: item.product_id, quantity: real },
            session,
          );
          if (Array.isArray(consumed) && consumed.length) {
            item.batches = consumed;
          }
          touchedProductIds.add(String(item.product_id));
        } catch (batchErr) {
          logger.warn(
            { orderId: String(order._id), productId: String(item.product_id), err: batchErr?.message },
            "consumo de lotes (FEFO) falló — pick continúa (best-effort)",
          );
        }
      }
      // Recalcular Product.expiry_date de cada producto tocado tras el consumo.
      // También best-effort: nunca propaga.
      for (const pid of touchedProductIds) {
        try {
          await recomputeProductExpiry(pid, session);
        } catch (expErr) {
          logger.warn(
            { orderId: String(order._id), productId: pid, err: expErr?.message },
            "recomputeProductExpiry falló tras pick — se ignora (best-effort)",
          );
        }
      }
      order.stock_committed = true;
      await logOrderStockMovements(
        {
          order,
          type: MOVEMENT_TYPES.SALE,
          sign: -1,
          reason: "Salida por pick confirmado",
          by: by || { label: "bodega" },
          stockAfterMap,
        },
        session,
      );
      logger.info({ orderId: String(order._id) }, "pick confirmado: físico descontado");
    }

    order.status = targetStatus;
    if (targetStatus === ORDER_STATUS.SHIPPED) {
      order.shipped_at = new Date();
      if (trackingNumber) {
        if (!order.shipping) order.shipping = {};
        order.shipping.tracking_number = String(trackingNumber).trim();
      }
    }
    appendHistory(order, targetStatus, {
      note: note || "Pick confirmado · salida de bodega",
      by: by || { label: "bodega" },
    });
    await order.save({ session });
    return order;
  });
};

export const transitionOrderStatus = async ({
  orderId,
  newStatus,
  byAdmin = false,
  by = null,
  note = null,
  trackingNumber = null,
}) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Orden no encontrada");

  const fromStatus = order.status;

  // Pago contra entrega: el pedido se prepara ANTES de cobrarse (el pago ocurre
  // al entregar). Es la única excepción a "primero el pago"; webpay y
  // transferencia siguen exigiendo la confirmación antes de preparar.
  const contraEntrega =
    fromStatus === ORDER_STATUS.PENDING &&
    newStatus === ORDER_STATUS.PREPARING &&
    order.payment?.method === "cash_on_pickup";

  if (!contraEntrega) {
    const check = puedeTransicionar(fromStatus, newStatus, {
      deliveryMethod: order.delivery_method,
    });
    if (!check.ok) throw new ConflictError(check.motivo);
  }

  // Efectivo al retirar impago NO se entrega: sin este guard, ready→delivered
  // sacaba el pedido sin cobro (fuera del Cierre Z pero contado como venta).
  // No afecta transfer/webpay: esos llegan a ready ya con payment approved.
  if (
    newStatus === ORDER_STATUS.DELIVERED &&
    ["cash_on_pickup", "efectivo"].includes(order.payment?.method) &&
    order.payment?.status !== PAYMENT_STATUS.APPROVED
  ) {
    throw new ConflictError("Cobra el pedido antes de entregarlo");
  }

  if (newStatus === ORDER_STATUS.CANCELLED) {
    return cancelOrder({ orderId, reason: note || "transition", byAdmin, by });
  }

  // PENDING→PAID por admin (transfer/cash_on_pickup): camino simple sin webpay
  // (aplica cupón, setea paid_at, payment.status=approved).
  if (newStatus === ORDER_STATUS.PAID) {
    return markAsPaid({ orderId, by, note });
  }

  // PAID/DELIVERED→REFUNDED: repone stock y revierte cupón con la MISMA
  // mecánica idempotente de cancelOrder (kardex sign +1, stock_restored).
  if (newStatus === ORDER_STATUS.REFUNDED) {
    return refundOrder({ orderId, reason: note, byAdmin, by });
  }

  // Pick confirmado: el físico SALE de bodega (Fase 4). Aplica a →ready y también
  // a →shipped (flujo legacy que salta "ready") para no dejar la salida sin
  // descontar. Descuenta stock + kardex de venta. Idempotente vía stock_committed.
  if (
    !order.stock_committed &&
    (newStatus === ORDER_STATUS.READY || newStatus === ORDER_STATUS.SHIPPED)
  ) {
    return commitOrderPick({ orderId, targetStatus: newStatus, by, note, trackingNumber });
  }

  order.status = newStatus;
  if (newStatus === ORDER_STATUS.SHIPPED) order.shipped_at = new Date();
  if (newStatus === ORDER_STATUS.DELIVERED) order.delivered_at = new Date();
  // Retiro en bodega: registrar el momento del retiro al marcar entregado.
  if (newStatus === ORDER_STATUS.DELIVERED && order.delivery_method === "pickup") {
    if (!order.pickup) order.pickup = {};
    order.pickup.picked_up_at = new Date();
  }
  if (trackingNumber) {
    if (!order.shipping) order.shipping = {};
    order.shipping.tracking_number = String(trackingNumber).trim();
  }
  appendHistory(order, newStatus, { note, by });

  await order.save();

  logger.info(
    { orderId: String(order._id), from: fromStatus, to: newStatus, byAdmin },
    "transición de orden aplicada",
  );
  emitRelayChange({ type: "status", id: String(order._id), status: newStatus });
  return order;
};

/* --------------------------- utilidades públicas ------------------------- */

export const findOrderForOwner = async ({
  orderId,
  identity,
  includeGuestToken = false,
}) => {
  const query = Order.findById(orderId);
  if (includeGuestToken) query.select("+guest_token_hash");

  const order = await query;
  if (!order) throw new NotFoundError("Orden no encontrada");

  const owner = isOrderOwner({
    order,
    userId: identity.userId,
    guestId: identity.guestId,
    guestToken: identity.guestToken,
  });
  if (!owner) throw new ForbiddenError("No autorizado");
  return order;
};

export const verifyGuestOrderAccess = async ({ orderId, token }) => {
  const order = await Order.findById(orderId).select("+guest_token_hash");
  if (!order) throw new NotFoundError("Orden no encontrada");
  if (order.user_id) throw new ForbiddenError("Orden con usuario registrado");
  if (!verifyGuestToken(token, order.guest_token_hash)) {
    throw new ForbiddenError("Token de invitado inválido");
  }
  return order;
};

export { hashGuestToken, verifyGuestToken, issueGuestToken, isOrderOwner };
