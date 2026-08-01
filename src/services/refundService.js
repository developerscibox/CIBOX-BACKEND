import mongoose from "mongoose";
import { Refund } from "../models/Refund.js";
import { logger } from "../utils/logger.js";
import { withTransaction } from "../utils/transactions.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { ORDER_STATUS, PAID_STATUSES, MOVEMENT_TYPES } from "../utils/constants.js";
import { logMovement } from "./inventoryService.js";
import { releaseAllocated } from "./stockService.js";
import { env } from "../config/env.js";

const REFUND_WINDOW_DAYS = 7;

const getOrderModel = () => {
  if (!mongoose.models.Order) {
    throw new Error("Order model not registered");
  }
  return mongoose.models.Order;
};

const getProductModel = () => mongoose.models.Product || null;

const isWithinRefundWindow = (paidAt) => {
  if (!paidAt) return false;
  const ms = REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - new Date(paidAt).getTime() <= ms;
};

const assertOrderOwnership = (order, identity) => {
  const { userId, guestId } = identity || {};
  if (userId && String(order.user_id) === String(userId)) return true;
  if (guestId && order.guest_id && String(order.guest_id) === String(guestId)) return true;
  throw new ForbiddenError("No tienes permiso sobre esta orden");
};

export const requestRefund = async ({
  orderId,
  identity,
  reason,
  description = "",
  items = [],
  type,
}) => {
  const Order = getOrderModel();
  const order = await Order.findById(orderId).lean();
  if (!order) throw new NotFoundError("Orden no encontrada");

  if (identity) assertOrderOwnership(order, identity);

  if (!PAID_STATUSES.includes(order.status)) {
    throw new ConflictError("La orden no es elegible para reembolso");
  }

  const paidAt = order.paid_at || order.payment?.paid_at || order.updated_at;
  if (!isWithinRefundWindow(paidAt)) {
    throw new ConflictError(
      `Ventana de reembolso vencida (${REFUND_WINDOW_DAYS} días)`
    );
  }

  let amount = 0;
  if (type === "full") {
    amount = Number(order.total || 0);
  } else {
    if (!items.length) throw new BadRequestError("Items requeridos para refund parcial");
    amount = items.reduce((acc, it) => acc + Number(it.amount || 0), 0);
    if (amount <= 0) throw new BadRequestError("Monto a reembolsar inválido");
    // Tope acumulado: lo ya reembolsado (procesado) + lo pendiente + este monto no
    // puede superar lo pagado. Chequeo temprano (best-effort; el guard autoritativo
    // está en approveRefund, dentro de la transacción).
    const prior = await Refund.aggregate([
      { $match: { order_id: order._id, status: { $in: ["pending", "processed"] } } },
      { $group: { _id: null, sum: { $sum: "$amount" } } },
    ]);
    const priorSum = Number(prior?.[0]?.sum || 0);
    if (priorSum + amount > Number(order.total || 0)) {
      throw new BadRequestError(
        "El monto excede lo reembolsable de la orden (considerando reembolsos previos o pendientes)"
      );
    }
  }

  const refund = await Refund.create({
    order_id: order._id,
    user_id: order.user_id || null,
    guest_id: order.guest_id || null,
    vendor_id: null,
    amount,
    reason,
    description,
    items,
    type,
    status: "pending",
    created_by: identity?.userId ? String(identity.userId) : "guest",
  });

  logger.info(
    { refund_id: String(refund._id), order_id: String(order._id), type, amount },
    "refund.requested"
  );

  return refund.toObject();
};

export const webpayRefund = async (token, amount) => {
  if (!token) {
    return { ok: false, response: { error: "missing_token" } };
  }
  try {
    const sdk = await import("transbank-sdk");
    const { WebpayPlus, Options, IntegrationCommerceCodes, IntegrationApiKeys, Environment } =
      sdk;

    const isProd = env.WEBPAY_ENV === "production";
    const commerceCode = isProd
      ? env.WEBPAY_COMMERCE_CODE
      : IntegrationCommerceCodes.WEBPAY_PLUS;
    const apiKey = isProd ? env.WEBPAY_API_KEY : IntegrationApiKeys.WEBPAY;
    const environment = isProd ? Environment.Production : Environment.Integration;

    const tx = new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment));
    const response = await tx.refund(token, amount);
    return { ok: true, response };
  } catch (err) {
    logger.error({ err: { message: err.message } }, "webpayRefund.failed");
    return { ok: false, response: { error: err.message } };
  }
};

export const approveRefund = async ({ refundId, adminId }) => {
  const Order = getOrderModel();
  const Product = getProductModel();

  return withTransaction(async (session) => {
    const refund = await Refund.findById(refundId).session(session);
    if (!refund) throw new NotFoundError("Refund no encontrado");
    if (refund.status !== "pending") {
      // Idempotencia: si ya está procesado, retornar
      if (refund.status === "processed") return refund.toObject();
      throw new ConflictError(`Refund en estado ${refund.status}`);
    }

    const order = await Order.findById(refund.order_id).session(session);
    if (!order) throw new NotFoundError("Orden no encontrada");

    // FSM safety: un reembolso TOTAL no debe aplicarse a una orden ya cerrada
    // (cancelada o ya reembolsada). En esos estados el stock ya fue manejado y
    // el estado es terminal; reabrirlo evadiría la máquina de estados y
    // duplicaría la reposición de inventario.
    if (
      refund.type === "full" &&
      [ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(order.status)
    ) {
      throw new ConflictError(
        `No se puede reembolsar (total) una orden en estado ${order.status}`
      );
    }

    // Guard anti-sobre-reembolso (AUTORITATIVO, dentro de la transacción, ANTES de
    // mover plata): la suma de lo ya reembolsado (procesado) + este monto no puede
    // superar lo pagado. Cubre reembolsos parciales múltiples y full tras parciales.
    const processedAgg = await Refund.aggregate([
      { $match: { order_id: order._id, status: "processed", _id: { $ne: refund._id } } },
      { $group: { _id: null, sum: { $sum: "$amount" } } },
    ]).session(session);
    const refundedSoFar = Number(processedAgg?.[0]?.sum || 0);
    const orderPaid = Number(order.total || 0);
    if (refundedSoFar + Number(refund.amount) > orderPaid + 0.5) {
      throw new ConflictError(
        `El reembolso excede lo pagado (ya reembolsado $${Math.round(refundedSoFar)} + este $${Math.round(Number(refund.amount))} > pagado $${Math.round(orderPaid)})`
      );
    }

    const token = order.payment?.token || order.payment?.transbank_token || null;

    const { ok, response } = await webpayRefund(token, refund.amount);

    if (!ok) {
      refund.status = "failed";
      refund.transbank_response = response;
      refund.processed_at = new Date();
      refund.processed_by = adminId || null;
      await refund.save({ session });

      logger.warn(
        { refund_id: String(refund._id), response },
        "refund.failed"
      );
      return refund.toObject();
    }

    refund.status = "processed";
    refund.transbank_response = response;
    refund.processed_at = new Date();
    refund.processed_by = adminId || null;
    await refund.save({ session });

    // Reverte stock (con registro en kardex)
    const restoreWithKardex = async (productId, quantity, name = "") => {
      const qty = Number(quantity || 0);
      if (!productId || qty <= 0) return;
      const updated = await Product.findOneAndUpdate(
        { _id: productId },
        { $inc: { stock: qty } },
        { new: true, session }
      );
      await logMovement(
        {
          productId,
          productName: updated?.name || name,
          orderId: order._id,
          type: MOVEMENT_TYPES.REFUND,
          quantity: qty,
          stockAfter: updated?.stock ?? null,
          reason: `Reembolso ${refund.type} aprobado`,
          by: { user_id: adminId || null, role: "admin", label: "admin" },
        },
        session
      );
    };

    // Fase 4: devolver inventario según si el físico ya salió en el pick.
    // - stock_committed → reponer físico + kardex (restoreWithKardex).
    // - aún comprometido (sin pick) → liberar allocated, sin movimiento físico.
    const committed = Boolean(order.stock_committed);
    const returnItem = async (productId, quantity, name) => {
      const qty = Number(quantity || 0);
      if (!productId || qty <= 0) return;
      if (committed) {
        await restoreWithKardex(productId, qty, name);
      } else {
        await releaseAllocated({ productId, qty }, session);
      }
    };

    if (Product && refund.items?.length) {
      // Reembolso parcial: repone/libera solo los ítems indicados. Idempotencia
      // por el estado del propio Refund (no se aprueba dos veces el mismo refund).
      for (const it of refund.items) {
        await returnItem(it.product_id, it.quantity, it.name);
      }
    } else if (
      Product &&
      refund.type === "full" &&
      Array.isArray(order.items) &&
      !order.stock_restored
    ) {
      // Reembolso total: una sola vez, vía el flag order.stock_restored.
      for (const it of order.items) {
        await returnItem(it.product_id, it.quantity, it.name);
      }
      order.stock_restored = true;
    }

    if (refund.type === "full") {
      order.status = ORDER_STATUS.REFUNDED;
      if (order.payment) order.payment.status = "refunded";
      await order.save({ session });
    } else {
      order.partial_refunded_amount =
        Number(order.partial_refunded_amount || 0) + Number(refund.amount);
      await order.save({ session });
    }

    logger.info(
      {
        refund_id: String(refund._id),
        order_id: String(order._id),
        amount: refund.amount,
        admin_id: String(adminId || ""),
      },
      "refund.processed"
    );

    return refund.toObject();
  });
};

export const rejectRefund = async ({ refundId, adminId, reason }) => {
  const refund = await Refund.findById(refundId);
  if (!refund) throw new NotFoundError("Refund no encontrado");
  if (refund.status !== "pending") {
    throw new ConflictError(`Refund en estado ${refund.status}`);
  }
  refund.status = "rejected";
  refund.processed_at = new Date();
  refund.processed_by = adminId || null;
  refund.transbank_response = { rejection_reason: reason };
  await refund.save();

  logger.info(
    { refund_id: String(refund._id), admin_id: String(adminId || "") },
    "refund.rejected"
  );
  return refund.toObject();
};

export const listRefunds = async ({
  status,
  userId,
  adminView = false,
  page = 1,
  limit = 20,
}) => {
  const filter = {};
  if (status) filter.status = status;
  if (!adminView && userId) filter.user_id = userId;
  if (adminView && userId) filter.user_id = userId;

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    Refund.countDocuments(filter),
  ]);

  return { items, total, page, limit };
};

export const getRefundById = async (refundId) => {
  const refund = await Refund.findById(refundId).lean();
  if (!refund) throw new NotFoundError("Refund no encontrado");
  return refund;
};
