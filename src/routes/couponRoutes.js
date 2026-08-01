import { Router } from "express";

import { protect, optionalAuth  } from "../middlewares/authMiddleware.js";
import { requireAdmin } from "../middlewares/roleMiddleware.js";
import { validate } from "../middlewares/validate.js";
import { couponLimiter } from "../middlewares/rateLimiters.js";

import {
  validateCoupon,
  adminCreateCoupon,
  adminListCoupons,
  adminGetCoupon,
  adminUpdateCoupon,
  adminToggleCoupon,
  adminDeleteCoupon,
  checkoutCouponPreview,
} from "../controllers/couponController.js";

import {
  validateCouponSchema,
  adminCreateCouponSchema,
  adminUpdateCouponSchema,
  couponIdParamSchema,
} from "../validators/couponValidators.js";

const router = Router();

router.post(
  "/validate",
  couponLimiter,
  protect,
  validate(validateCouponSchema),
  validateCoupon,
);
router.post("/checkout-preview", couponLimiter, optionalAuth, checkoutCouponPreview);
// Admin
router.post(
  "/admin",
  protect,
  requireAdmin,
  validate(adminCreateCouponSchema),
  adminCreateCoupon,
);
router.get("/admin", protect, requireAdmin, adminListCoupons);
router.get(
  "/admin/:id",
  protect,
  requireAdmin,
  validate(couponIdParamSchema),
  adminGetCoupon,
);
router.patch(
  "/admin/:id",
  protect,
  requireAdmin,
  validate(adminUpdateCouponSchema),
  adminUpdateCoupon,
);
router.post(
  "/admin/:id/toggle",
  protect,
  requireAdmin,
  validate(couponIdParamSchema),
  adminToggleCoupon,
);
router.delete(
  "/admin/:id",
  protect,
  requireAdmin,
  validate(couponIdParamSchema),
  adminDeleteCoupon,
);

export default router;
