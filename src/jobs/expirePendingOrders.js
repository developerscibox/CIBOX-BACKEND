import Order from "../models/Order.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { ORDER_STATUS, PAYMENT_STATUS, MOVEMENT_TYPES } from "../utils/constants.js";
import { cancelOrder } from "../services/orderService.js";
import mongoose from "mongoose";

/**
 * Job: expira órdenes pendientes de pago.
 *
 * El stock se descuenta al CREAR la orden, por lo que un checkout abandonado
 * retiene stock indefinidamente. Este job cancela (y repone stock vía
 * cancelOrder, que es idempotente) las órdenes pending cuyo pago nunca llegó.
 *
 * Seguridad frente a carreras:
 * - Solo toca órdenes con payment.status "pending" o "rejected". Si el pago
 *   está "processing"/"processing_commit" (usuario en Webpay) NO se toca.
 * - cancelOrder valida la transición: si el webhook de pago llegó primero
 *   (status ya "paid"), la cancelación falla con ConflictError y se omite.
 */
// TTL largo para pago presencial (transferencia / efectivo al retirar): estas
// órdenes NO caducan por el TTL corto (el cliente puede retirar días después),
// pero sin tope retienen allocated para siempre (auditoría H8).
const OFFLINE_PENDING_TTL_DAYS = 7;

export const expirePendingOrdersOnce = async () => {
  const ttlMs = env.ORDER_PENDING_TTL_MINUTES * 60 * 1000;
  const cutoff = new Date(Date.now() - ttlMs);

  const stale = await Order.find({
    status: ORDER_STATUS.PENDING,
    created_at: mongoose.trusted({ $lt: cutoff }),
    "payment.status": mongoose.trusted({
      $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.REJECTED],
    }),
    // Pago ONLINE (Webpay) abandonado: TTL corto en minutos.
    "payment.method": mongoose.trusted({ $in: ["webpay"] }),
  })
    .select("_id created_at")
    .limit(200)
    .lean();

  // Pago presencial: expira a los 7 días contados desde created_at o desde
  // pickup.committed_date si existe (lo que sea posterior). cancelOrder libera
  // el allocated por el mismo camino que webpay (idempotente).
  const offlineCutoff = new Date(
    Date.now() - OFFLINE_PENDING_TTL_DAYS * 24 * 60 * 60 * 1000
  );
  const staleOffline = await Order.find({
    status: ORDER_STATUS.PENDING,
    created_at: mongoose.trusted({ $lt: offlineCutoff }),
    "payment.status": mongoose.trusted({
      $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.REJECTED],
    }),
    "payment.method": mongoose.trusted({ $in: ["transfer", "cash_on_pickup"] }),
    $or: [
      { "pickup.committed_date": null },
      { "pickup.committed_date": mongoose.trusted({ $lt: offlineCutoff }) },
    ],
  })
    .select("_id payment.method")
    .limit(200)
    .lean();

  const jobs = [
    ...stale.map((doc) => ({
      doc,
      method: "webpay",
      reason: `Expirada: sin pago tras ${env.ORDER_PENDING_TTL_MINUTES} min`,
    })),
    ...staleOffline.map((doc) => ({
      doc,
      method: doc.payment?.method || "offline",
      reason: `Expirada: sin pago tras ${OFFLINE_PENDING_TTL_DAYS} días`,
    })),
  ];

  if (!jobs.length) return { expired: 0 };

  let expired = 0;
  const byMethod = {};
  for (const { doc, method, reason } of jobs) {
    try {
      await cancelOrder({
        orderId: doc._id,
        reason,
        byAdmin: true,
        by: { label: "sistema:expiracion" },
        movementType: MOVEMENT_TYPES.EXPIRY,
      });
      expired += 1;
      byMethod[method] = (byMethod[method] || 0) + 1;
    } catch (err) {
      // ConflictError esperable si la orden cambió de estado entre el find y el cancel
      logger.warn(
        { orderId: String(doc._id), err: err.message },
        "expiracion: orden omitida"
      );
    }
  }

  if (expired > 0) {
    logger.info(
      { expired, by_method: byMethod },
      "expiracion: órdenes pending canceladas y stock repuesto"
    );
  }
  return { expired, by_method: byMethod };
};

/**
 * Inicia el job periódico. Devuelve función para detenerlo (shutdown limpio).
 */
export const startPendingOrderExpiryJob = () => {
  const intervalMs = env.ORDER_EXPIRY_CHECK_MINUTES * 60 * 1000;

  const timer = setInterval(() => {
    expirePendingOrdersOnce().catch((err) =>
      logger.error({ err: err.message }, "expiracion: job falló")
    );
  }, intervalMs);
  timer.unref();

  // Primera pasada al arrancar (limpia lo acumulado si el server estuvo caído)
  expirePendingOrdersOnce().catch((err) =>
    logger.error({ err: err.message }, "expiracion: pasada inicial falló")
  );

  logger.info(
    {
      ttl_minutes: env.ORDER_PENDING_TTL_MINUTES,
      check_every_minutes: env.ORDER_EXPIRY_CHECK_MINUTES,
    },
    "expiracion: job iniciado"
  );

  return () => clearInterval(timer);
};
