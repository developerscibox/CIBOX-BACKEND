import crypto from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withTransaction } from "../utils/transactions.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { ORDER_STATUS, VALID_TRANSITIONS } from "../utils/constants.js";

import { lineaDeTiempo, avancePct, CLIENT_COPY } from "../pedidos/estados.js";
const getOrderModel = () => {
  if (!mongoose.models.Order) {
    throw new Error("Order model not registered");
  }
  return mongoose.models.Order;
};

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const matchesGuestToken = (order, token) => {
  if (!token) return false;
  const stored = order.guest_token_hash || order.guest_tracking_token_hash || null;
  if (!stored) return false;
  try {
    const a = Buffer.from(stored);
    const b = Buffer.from(hashToken(token));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

/**
 * Seguimiento que ve el CLIENTE. Sin PII de terceros ni datos internos: el
 * estado, la línea de tiempo del pedido (qué etapa se cumplió, cuándo y quién),
 * el avance y los datos del despacho.
 */
const buildPublicTracking = (order) => ({
  orderId: String(order._id),
  folio: String(order._id).slice(-6).toUpperCase(),
  status: order.status,
  estado: CLIENT_COPY[order.status]?.titulo || order.status,
  detalle: CLIENT_COPY[order.status]?.detalle || "",
  delivery_method: order.delivery_method || "delivery",
  avance_pct: avancePct(order),
  // Línea de tiempo: la máquina de estados (pedidos/estados.js) cruzada con el
  // status_history del pedido. Cada etapa dice si ya ocurrió, cuándo y quién.
  timeline: lineaDeTiempo(order),
  created_at: order.created_at || null,
  delivered_at: order.delivered_at || null,
  shipping: {
    carrier: order.shipping?.carrier || null,
    tracking_number: order.shipping?.tracking_number || null,
    shipment_status: order.shipping?.shipment_status || null,
    estimated_delivery: order.shipping?.estimated_delivery || null,
  },
  pickup: order.delivery_method === "pickup"
    ? { location: order.pickup?.location || null, committed_date: order.pickup?.committed_date || null }
    : null,
  items: Array.isArray(order.items)
    ? order.items.map((it) => ({
        name: it.name || "",
        quantity: Number(it.quantity || 0),
      }))
    : [],
});

export const getTrackingByToken = async ({ orderId, token, userId }) => {
  const Order = getOrderModel();
  const order = await Order.findById(orderId).lean();
  if (!order) throw new NotFoundError("Orden no encontrada");

  let authorized = false;
  if (userId && String(order.user_id || "") === String(userId)) authorized = true;
  if (!authorized && token && matchesGuestToken(order, token)) authorized = true;

  if (!authorized) throw new ForbiddenError("No autorizado para ver tracking");

  return buildPublicTracking(order);
};

export const syncTrackingFromBlueExpress = async (trackingNumber) => {
  if (!trackingNumber) throw new BadRequestError("tracking_number requerido");
  if (!env.BLUEEXPRESS_API_URL || !env.BLUEEXPRESS_API_KEY) {
    logger.warn({ trackingNumber }, "blueexpress.sync.skipped:not_configured");
    return null;
  }
  try {
    const url = `${env.BLUEEXPRESS_API_URL.replace(/\/$/, "")}/tracking/${encodeURIComponent(
      trackingNumber
    )}`;
    const r = await fetch(url, {
      headers: {
        "x-api-key": env.BLUEEXPRESS_API_KEY,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) {
      logger.warn({ status: r.status, trackingNumber }, "blueexpress.sync.failed");
      return null;
    }
    const data = await r.json();
    const Order = getOrderModel();
    const status = data?.status || data?.shipment_status || null;
    if (status) {
      await Order.updateOne(
        { "shipping.tracking_number": trackingNumber },
        { $set: { "shipping.shipment_status": status, "shipping.last_synced_at": new Date() } }
      );
    }
    return data;
  } catch (err) {
    logger.error({ err: { message: err.message }, trackingNumber }, "blueexpress.sync.error");
    return null;
  }
};

export const verifyBlueExpressSignature = ({ rawBody, signature }) => {
  const secret = env.BLUEEXPRESS_API_KEY;
  if (!secret) return false; // sin secret configurado, rechazamos (fail-closed)
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || {}))
    .digest("hex");
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

export const processBlueExpressWebhook = async (body) => {
  const Order = getOrderModel();
  const trackingNumber =
    body?.tracking_number || body?.trackingNumber || body?.guide || null;
  const status = body?.status || body?.shipment_status || null;

  if (!trackingNumber) {
    throw new BadRequestError("tracking_number requerido en el webhook");
  }

  return withTransaction(async (session) => {
    const order = await Order.findOne({
      "shipping.tracking_number": trackingNumber,
    }).session(session);

    if (!order) {
      logger.warn({ trackingNumber }, "blueexpress.webhook.order_not_found");
      return { processed: false, reason: "order_not_found" };
    }

    // Idempotencia: si el shipment_status ya es el mismo, no hacer nada
    if (order.shipping?.shipment_status === status) {
      return { processed: true, idempotent: true, orderId: String(order._id) };
    }

    if (!order.shipping) order.shipping = {};
    order.shipping.shipment_status = status;
    order.shipping.last_event_at = new Date();
    if (!Array.isArray(order.shipping.events)) order.shipping.events = [];
    order.shipping.events.push({
      status,
      at: new Date(),
      raw: body,
    });

    // Solo mutar order.status si la transición es válida según la máquina de
    // estados; si no, registramos el evento de shipping sin tocar order.status.
    const allowedTransitions = VALID_TRANSITIONS[order.status] || [];
    if (
      status === "delivered" &&
      allowedTransitions.includes(ORDER_STATUS.DELIVERED)
    ) {
      order.status = ORDER_STATUS.DELIVERED;
      order.delivered_at = new Date();
    } else if (
      status === "in_transit" &&
      allowedTransitions.includes(ORDER_STATUS.SHIPPED)
    ) {
      order.status = ORDER_STATUS.SHIPPED;
      order.shipped_at = new Date();
    }

    await order.save({ session });

    logger.info(
      {
        order_id: String(order._id),
        trackingNumber,
        status,
        new_order_status: order.status,
      },
      "blueexpress.webhook.processed"
    );

    return { processed: true, orderId: String(order._id), status };
  });
};
