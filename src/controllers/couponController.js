import Coupon from "../models/Coupon.js";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { logger } from "../utils/logger.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors.js";

import {
  validateCouponForUser,
  findCouponByCode,
  calculateCouponDiscount,
  findFirstPurchaseAutoCoupon,
} from "../services/couponService.js";

/**
 * POST /coupons/validate
 * Body: { code, subtotal? }
 * Retorna SOLO { valid, message, discount_preview, code } — nunca el doc completo.
 */
export const validateCoupon = asyncHandler(async (req, res) => {
  const { code, subtotal } = req.body;
  const userId = req.user?.id || null;

  const coupon = await findCouponByCode(code);
  if (!coupon) {
    return res.status(200).json({
      success: true,
      data: { valid: false, message: "Cupón no encontrado" },
    });
  }

  const result = await validateCouponForUser({
    coupon,
    userId,
    subtotal: Number(subtotal || 0),
  });

  return res.status(200).json({
    success: true,
    data: {
      valid: result.valid,
      message: result.message || null,
      code: coupon.code,
      discount_preview: result.discount_preview ?? null,
      discount_type: result.valid ? coupon.discount_type : null,
    },
  });
});

/* ------------------------------ admin CRUD ------------------------------- */

export const adminCreateCoupon = asyncHandler(async (req, res) => {
  const data = req.body;
  const code = String(data.code || "")
    .trim()
    .toUpperCase();
  if (!code) throw new BadRequestError("code requerido");

  const exists = await Coupon.findOne({ code });
  if (exists) throw new ConflictError("El cupón ya existe");

  const coupon = await Coupon.create({ ...data, code });

  return res.status(201).json({ success: true, data: coupon });
});

export const adminListCoupons = asyncHandler(async (req, res) => {
  const coupons = await Coupon.find().sort({ created_at: -1 }).limit(500);
  return res.status(200).json({ success: true, data: coupons });
});

export const adminGetCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw new NotFoundError("Cupón no encontrado");
  return res.status(200).json({ success: true, data: coupon });
});

export const adminUpdateCoupon = asyncHandler(async (req, res) => {
  const updates = req.body;
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });
  if (!coupon) throw new NotFoundError("Cupón no encontrado");
  return res.status(200).json({ success: true, data: coupon });
});

export const adminToggleCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw new NotFoundError("Cupón no encontrado");
  coupon.is_active = !coupon.is_active;
  await coupon.save();
  return res.status(200).json({ success: true, data: coupon });
});

export const adminDeleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByIdAndDelete(req.params.id);
  if (!coupon) throw new NotFoundError("Cupón no encontrado");
  return res.status(200).json({ success: true, message: "Cupón eliminado" });
});

export const checkoutCouponPreview = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  const subtotal = Number(req.body?.subtotal || 0);

  logger.debug({ has_user: Boolean(userId), subtotal }, "coupon.checkoutPreview");

  if (!userId || subtotal <= 0) {
    return res.status(200).json({
      success: true,
      data: {
        applies: false,
        discount_amount: 0,
      },
    });
  }

  const coupon = await findFirstPurchaseAutoCoupon();

  if (!coupon) {
    return res.status(200).json({
      success: true,
      data: {
        applies: false,
        discount_amount: 0,
      },
    });
  }

  const validation = await validateCouponForUser({
    coupon,
    userId,
    subtotal,
  });

  if (!validation.valid) {
    return res.status(200).json({
      success: true,
      data: {
        applies: false,
        discount_amount: 0,
        message: validation.message,
      },
    });
  }

  const discountAmount = calculateCouponDiscount({ coupon, subtotal });

  return res.status(200).json({
    success: true,
    data: {
      applies: true,
      code: coupon.code,
      label: "Descuento primera compra",
      discount_amount: discountAmount,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
    },
  });
});
