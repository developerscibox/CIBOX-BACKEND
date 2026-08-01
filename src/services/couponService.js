import Coupon from "../models/Coupon.js";
import CouponUsage from "../models/CouponUsage.js";
import Order from "../models/Order.js";
import { ConflictError } from "../utils/errors.js";

/**
 * Carga un cupón por código (uppercase normalizado). Lanza NotFoundError si no existe.
 */
export const findCouponByCode = async (code) => {
  if (!code) return null;
  return Coupon.findOne({ code: String(code).trim().toUpperCase() });
};
export const findFirstPurchaseAutoCoupon = async () => {
  return Coupon.findOne({
    code: "BIENVENIDA10",
    is_active: true,
    first_purchase_only: true,
  });
};

/**
 * Valida un cupón para un usuario o invitado y un subtotal dado.
 * Retorna { valid, message?, discount_preview? }.
 */
export const validateCouponForUser = async ({ coupon, userId, subtotal }) => {
  if (!coupon) return { valid: false, message: "Cupón no encontrado" };

  const now = new Date();

  if (!coupon.is_active) return { valid: false, message: "Cupón inactivo" };

  // Cupón restringido a un usuario específico (ej: recompensa de misión)
  if (coupon.allowed_user_id) {
    if (!userId || String(coupon.allowed_user_id) !== String(userId)) {
      return {
        valid: false,
        message: "Este cupón no es válido para tu cuenta",
      };
    }
  }

  if (coupon.starts_at && now < new Date(coupon.starts_at)) {
    return { valid: false, message: "Cupón aún no está activo" };
  }

  if (coupon.expires_at && now > new Date(coupon.expires_at)) {
    return { valid: false, message: "Cupón expirado" };
  }

  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) {
    return { valid: false, message: "Cupón sin usos disponibles" };
  }

  const sub = Number(subtotal || 0);
  const minSub = Number(coupon.min_subtotal || 0);
  if (sub < minSub) {
    return {
      valid: false,
      message: `Compra mínima requerida: ${minSub}`,
    };
  }

  if (userId) {
    const userUses = await CouponUsage.countDocuments({
      coupon_id: coupon._id,
      user_id: userId,
    });

    if (userUses >= Number(coupon.max_uses_per_user || 1)) {
      return {
        valid: false,
        message: "Ya alcanzaste el máximo de usos para este cupón",
      };
    }

    if (coupon.first_purchase_only) {
      const previousOrders = await Order.countDocuments({
        user_id: userId,
        status: { $in: ["paid", "preparing", "shipped", "delivered"] },
      });
      if (previousOrders > 0) {
        return {
          valid: false,
          message: "Cupón válido solo para la primera compra",
        };
      }
    }
  } else {
    // Sin userId = guest. Si el cupón es solo primera compra, bloquearlo.
    if (coupon.first_purchase_only) {
      return {
        valid: false,
        message: "Cupón válido solo para usuarios registrados",
      };
    }
  }

  const discountPreview = calculateCouponDiscount({ coupon, subtotal: sub });
  return { valid: true, discount_preview: discountPreview };
};

/**
 * Calcula el monto de descuento (entero) en base a tipo y subtotal.
 */
export const calculateCouponDiscount = ({ coupon, subtotal }) => {
  if (!coupon) return 0;

  const sub = Number(subtotal || 0);
  if (sub <= 0) return 0;

  let discount = 0;
  if (coupon.discount_type === "percent") {
    discount = Math.round(sub * (Number(coupon.discount_value) / 100));
  } else if (coupon.discount_type === "fixed") {
    discount = Math.round(Number(coupon.discount_value));
  }

  if (coupon.max_discount != null) {
    discount = Math.min(discount, Number(coupon.max_discount));
  }

  return Math.max(0, Math.min(discount, sub));
};

/**
 * Aplica el cupón a la orden DENTRO de una sesión transaccional:
 * - crea CouponUsage (índice único por {coupon_id, order_id} hace idempotente)
 * - incrementa used_count
 * Llamar dentro de finalizePaidOrder.
 */
export const applyCouponToOrder = async (
  { coupon, userId, guestId, orderId, discountAmount },
  session,
) => {
  if (!coupon || !discountAmount || Number(discountAmount) <= 0) {
    return null;
  }

  // Uso único por usuario: para cupones de 1 uso por persona, la clave activa el
  // índice único parcial (coupon_id, single_use_key) → reuso concurrente = E11000.
  const singleUseKey =
    userId && Number(coupon.max_uses_per_user || 1) === 1 ? userId : null;

  let usage;
  try {
    [usage] = await CouponUsage.create(
      [
        {
          coupon_id: coupon._id,
          user_id: userId || null,
          guest_id: userId ? null : guestId || null,
          order_id: orderId,
          code: coupon.code,
          discount_amount: Number(discountAmount),
          single_use_key: singleUseKey,
        },
      ],
      { session },
    );
  } catch (err) {
    if (err?.code === 11000) {
      // Choque contra el índice de uso único por usuario → reuso real: rechazar.
      if (err?.keyPattern?.single_use_key) {
        throw new ConflictError("Ya usaste este cupón");
      }
      // Choque contra (coupon_id, order_id) → misma orden reprocesada: idempotente.
      return null;
    }
    throw err;
  }

  const updateResult = await Coupon.collection.updateOne(
    {
      _id: coupon._id,
      $or: [
        { max_uses: null },
        { $expr: { $lt: ["$used_count", "$max_uses"] } },
      ],
    },
    { $inc: { used_count: 1 } },
    { session },
  );

  if (updateResult.modifiedCount === 0) {
    throw new ConflictError("Cupón sin usos disponibles");
  }

  return usage;
};

/**
 * Revierte la aplicación de un cupón: elimina CouponUsage y decrementa used_count.
 * Idempotente.
 */
export const revertCouponUsage = async ({ orderId }, session) => {
  const usage = await CouponUsage.findOneAndDelete(
    { order_id: orderId },
    { session },
  );

  if (!usage) return null;

  await Coupon.updateOne(
    { _id: usage.coupon_id, used_count: { $gt: 0 } },
    { $inc: { used_count: -1 } },
    { session },
  );

  return usage;
};
