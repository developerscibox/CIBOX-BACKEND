import mongoose from "mongoose";
import Order from "../models/Order.js";
import { getTransaction, webpayReturnUrl } from "../config/webpay.js";
import { logger } from "../utils/logger.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors.js";
import { PAYMENT_STATUS, ORDER_STATUS } from "../utils/constants.js";
import { finalizePaidOrder } from "./orderService.js";
import { createNotification } from "../utils/notification.js";
import { sendPushToUser } from "./pushService.js";

// Ventana tras la cual un commit "processing_commit" se considera interrumpido
// (proceso caído entre el lock y el commit, o fallo al liberar el lock) y puede
// recuperarse: re-commit del mismo token o reintento de pago.
const STUCK_COMMIT_MS = 5 * 60 * 1000;

// Ventana durante la cual una sesión Webpay en "processing" se considera viva:
// si ya existe un token reciente, no se crea uno nuevo (evita dejar dos
// sesiones Webpay simultáneas para la misma orden / doble token).
const PROCESSING_LOCK_MS = 5 * 60 * 1000;

const isStuckCommit = (order) => {
  if (order?.payment?.status !== PAYMENT_STATUS.PROCESSING_COMMIT) return false;
  const since = order.payment?.transaction_date || order.updated_at || order.updatedAt;
  if (!since) return true; // sin marca temporal → asumimos atrapada
  return Date.now() - new Date(since).getTime() > STUCK_COMMIT_MS;
};

const buildBuyOrder = (orderId) => {
  const shortId = String(orderId).slice(-10);
  const shortTs = Date.now().toString().slice(-8);
  return `O${shortId}${shortTs}`.slice(0, 26);
};

const buildSessionId = ({ userId, guestId, orderId }) => {
  if (userId) return String(userId).slice(-20);
  if (guestId) return String(guestId).slice(-20);
  return `g_${String(orderId).slice(-18)}`;
};

/**
 * Crea una transacción Webpay para una orden pendiente.
 * - Ownership debe verificarse antes de invocar este servicio (controller).
 * - Si la orden ya tiene token activo y está en pending, podría re-usarse según política.
 */
export const createWebpayTransaction = async ({ order, platform }) => {
  if (!order) throw new NotFoundError("Orden no encontrada");
  if (order.status !== ORDER_STATUS.PENDING) {
    throw new ConflictError(
      "Solo se puede pagar una orden en estado pendiente",
    );
  }

  if (
    order.payment?.status === PAYMENT_STATUS.APPROVED ||
    order.payment?.webhook_processed_at
  ) {
    throw new ConflictError("La orden ya fue pagada");
  }

  // VULN doble token: si ya hay una sesión Webpay viva (processing + token y
  // creada hace poco), no abrir una segunda. Mantener dos tokens simultáneos
  // deja dos sesiones de pago abiertas para la misma orden.
  if (
    order.payment?.status === PAYMENT_STATUS.PROCESSING &&
    order.payment?.token &&
    order.payment?.transaction_date &&
    Date.now() - new Date(order.payment.transaction_date).getTime() <
      PROCESSING_LOCK_MS
  ) {
    throw new BadRequestError(
      "Pago en proceso, intenta de nuevo en unos minutos",
    );
  }

  const buyOrder = buildBuyOrder(order._id);
  const sessionId = buildSessionId({
    userId: order.user_id,
    guestId: order.guest_id,
    orderId: order._id,
  });
  const amount = Math.round(Number(order.total || 0));

  if (amount <= 0) {
    throw new BadRequestError("El monto a cobrar debe ser mayor a 0");
  }

  const tx = getTransaction();
  // console.log("WEBPAY RETURN URL ENVIADA A TRANSBANK:", webpayReturnUrl);
  // console.log("WEBPAY PLATFORM RECIBIDA:", platform);
  const response = await tx.create(
    buyOrder,
    sessionId,
    amount,
    webpayReturnUrl,
  );

  const safePlatform = ["web", "ios", "android"].includes(platform)
    ? platform
    : "web";

  order.payment = {
    ...(order.payment?.toObject
      ? order.payment.toObject()
      : order.payment || {}),
    method: "webpay",
    platform: safePlatform,
    status: PAYMENT_STATUS.PROCESSING,
    token: response.token,
    buy_order: buyOrder,
    session_id: sessionId,
    amount,
    // Marca de creación de la sesión Webpay: habilita el bloqueo de doble token
    // (ventana PROCESSING_LOCK_MS). El commit la sobrescribe al confirmar.
    transaction_date: new Date(),
  };

  await order.save();

  logger.info(
    { orderId: String(order._id), buyOrder, amount },
    "Webpay transaction creada",
  );

  return {
    orderId: order._id,
    paymentToken: response.token,
    paymentUrl: response.url,
  };
};

/**
 * Confirma una transacción Webpay con lock optimista + validación amount.
 * Idempotente: si otro proceso ya hizo commit, lo detecta y retorna la orden actual.
 */
export const commitWebpayTransaction = async ({ token }) => {
  if (!token) throw new BadRequestError("Token requerido");

  // FIX: usar Order.findOneAndUpdate (Mongoose) en vez de Order.collection.*
  // Order.collection devuelve un doc crudo sin .save() → TypeError en el catch
  // mongoose.trusted() necesario para que sanitizeFilter no castee el $in a string
  let locked = await Order.findOneAndUpdate(
    {
      "payment.token": token,
      "payment.status": mongoose.trusted({ $in: ["pending", "processing"] }),
    },
    {
      $set: {
        "payment.status": "processing_commit",
        "payment.transaction_date": new Date(),
      },
    },
    { new: true },
  );

  // Si no se pudo bloquear: ya fue procesada (idempotente) o quedó atrapada en
  // processing_commit por un commit interrumpido (proceso caído / fallo al
  // liberar el lock). En el segundo caso, si pasó la ventana de gracia, se
  // re-toma el lock para re-commitear el mismo token (Transbank.commit es
  // idempotente y devuelve el estado real de la transacción).
  if (!locked) {
    const existing = await Order.findOne({ "payment.token": token });
    if (!existing) throw new NotFoundError("Orden no encontrada para el token");

    if (isStuckCommit(existing)) {
      // Cierra la carrera: solo recupera si el lock previo ya superó la ventana
      // (transaction_date < now - STUCK_COMMIT_MS). Al setear transaction_date a
      // "ahora", un 2º recuperador concurrente ya no matchea y obtiene null.
      locked = await Order.findOneAndUpdate(
        {
          "payment.token": token,
          "payment.status": "processing_commit",
          "payment.transaction_date": mongoose.trusted({
            $lt: new Date(Date.now() - STUCK_COMMIT_MS),
          }),
        },
        { $set: { "payment.transaction_date": new Date() } },
        { new: true },
      );
      if (locked) {
        logger.warn(
          { orderId: String(locked._id) },
          "commit: recuperando orden atrapada en processing_commit — re-commit",
        );
      }
    }

    if (!locked) {
      logger.info(
        { orderId: String(existing._id), paymentStatus: existing.payment?.status },
        "commit: idempotente — orden ya procesada",
      );
      return existing;
    }
  }

  // tx debe vivir en el scope de toda la función: además del commit, se usa más
  // abajo para el refund automático cuando el monto autorizado no coincide.
  const tx = getTransaction();
  let response;
  try {
    response = await tx.commit(token);
  } catch (err) {
    // Liberar el lock — usar updateOne porque si .save() falla aquí la orden
    // queda atrapada en processing_commit sin posibilidad de reintento
    await Order.updateOne(
      { _id: locked._id },
      { $set: { "payment.status": PAYMENT_STATUS.REJECTED, "payment.transaction_date": new Date() } },
    );
    logger.error(
      { orderId: String(locked._id), err: err.message },
      "Webpay commit falló — lock liberado como rejected",
    );
    throw err;
  }

  const isAuthorized =
    response?.status === "AUTHORIZED" && Number(response?.response_code) === 0;

  const expectedAmount = Math.round(Number(locked.total || 0));
  const responseAmount = Math.round(Number(response?.amount || 0));
  const amountMatches = responseAmount === expectedAmount;

  // Persistir respuesta en el doc Mongoose (locked ya es documento Mongoose)
  locked.payment.authorization_code = response?.authorization_code || null;
  locked.payment.transaction_date = response?.transaction_date
    ? new Date(response.transaction_date)
    : new Date();
  locked.payment.response_code = response?.response_code ?? null;
  locked.payment.buy_order = response?.buy_order || locked.payment.buy_order;
  locked.payment.session_id = response?.session_id || locked.payment.session_id;
  locked.payment.amount = responseAmount || expectedAmount;

  if (!isAuthorized || !amountMatches) {
    locked.payment.status = PAYMENT_STATUS.REJECTED;
    await locked.save();

    if (isAuthorized && !amountMatches) {
      // Transbank YA capturó el dinero pero el monto no coincide con el total de
      // la orden. Revertir/anular el cobro de inmediato para no dejar un cargo
      // sin contrapartida (cargo retenido sin entrega).
      try {
        await tx.refund(token, responseAmount);
        locked.payment.status = PAYMENT_STATUS.REFUNDED;
        await locked.save();
        logger.warn(
          {
            orderId: String(locked._id),
            expected: expectedAmount,
            received: responseAmount,
            buy_order: response?.buy_order,
          },
          "monto Webpay no coincide → cobro revertido (refund) automáticamente",
        );
      } catch (refundErr) {
        logger.fatal(
          {
            orderId: String(locked._id),
            expected: expectedAmount,
            received: responseAmount,
            buy_order: response?.buy_order,
            refundErr: refundErr.message,
          },
          "ALERTA CRÍTICA: monto Webpay no coincide y el REVERSO automático FALLÓ — revisar y anular manualmente en Transbank",
        );
      }
    } else {
      logger.warn(
        {
          orderId: String(locked._id),
          status: response?.status,
          response_code: response?.response_code,
        },
        "Webpay rechazó la transacción",
      );
    }
    return locked;
  }

  // Autorizado y monto correcto → finalizar (idempotente)
  await finalizePaidOrder(locked._id);

  const refreshed = await Order.findById(locked._id);
  logger.info(
    { orderId: String(refreshed._id), total: refreshed.total },
    "Webpay commit aprobado y orden finalizada",
  );

  // Notificación in-app + push al pagar (solo usuarios autenticados)
  if (refreshed.user_id) {
    const shortId = String(refreshed._id).slice(-6).toUpperCase();
    const title = "✅ Pago confirmado";
    const body  = `Tu orden #${shortId} fue pagada. ¡Estamos preparándola!`;
    createNotification({
      user_id: refreshed.user_id,
      type: "order_status_changed",
      title,
      body,
      data: { orderId: String(refreshed._id), status: "paid" },
    }).catch(() => {});
    sendPushToUser({
      userId: refreshed.user_id,
      title,
      body,
      data: { orderId: String(refreshed._id), status: "paid" },
    }).catch(() => {});
  }

  return refreshed;
};

/**
 * Wrapper para el return URL desde Transbank (GET o POST con token_ws).
 */
export const handleWebpayReturn = async ({
  token_ws,
  TBK_TOKEN,
  TBK_ORDEN_COMPRA,
}) => {
  if (token_ws) {
    const order = await commitWebpayTransaction({ token: token_ws });
    return { kind: "commit", order };
  }

  if (TBK_TOKEN && TBK_ORDEN_COMPRA) {
    // El usuario abandonó el flujo Webpay
    const order = await Order.findOne({
      "payment.buy_order": TBK_ORDEN_COMPRA,
    });
    if (!order) {
      throw new NotFoundError("Orden no encontrada para TBK_ORDEN_COMPRA");
    }
    if (
      order.payment?.status === PAYMENT_STATUS.APPROVED ||
      order.payment?.webhook_processed_at
    ) {
      return { kind: "abandoned_already_paid", order };
    }
    // SEGURIDAD: NO mutar payment.status a REJECTED desde el retorno por
    // abandono. Esta ruta no tiene auth ni firma y buy_order es parcialmente
    // predecible, por lo que un atacante podría forzar el rechazo del pago de
    // una orden ajena (DoS de pagos). El único camino que cambia el estado del
    // pago es commit(token_ws) contra Transbank; el timeout de órdenes
    // pendientes lo maneja el job expirePendingOrders.
    return { kind: "abandoned", order };
  }

  throw new BadRequestError("Retorno Webpay inválido");
};

/**
 * Reintento de pago: para órdenes en pending con payment rejected o pending,
 * genera un nuevo token Webpay.
 */
export const retryPayment = async ({ order, platform }) => {
  if (!order) throw new NotFoundError("Orden no encontrada");
  if (order.status !== ORDER_STATUS.PENDING) {
    throw new ConflictError(
      "Solo se puede reintentar pago en órdenes pendientes",
    );
  }
  const ps = order.payment?.status;
  // processing_commit solo permite reintento si quedó atrapado (commit
  // interrumpido pasada la ventana de gracia); un commit en curso NO se reintenta.
  const stuckCommit =
    ps === PAYMENT_STATUS.PROCESSING_COMMIT && isStuckCommit(order);
  if (
    ps !== PAYMENT_STATUS.REJECTED &&
    ps !== PAYMENT_STATUS.PENDING &&
    ps !== PAYMENT_STATUS.PROCESSING &&
    !stuckCommit
  ) {
    throw new ConflictError(`Estado de pago no permite reintento: ${ps}`);
  }

  // Resetea token y crea uno nuevo
  order.payment.authorization_code = null;
  order.payment.response_code = null;
  order.payment.status = PAYMENT_STATUS.PENDING;

  return createWebpayTransaction({ order, platform });
};
