import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect, optionalAuth } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { guestOrderLimiter } from "../middlewares/rateLimiters.js";
import { PERMISSIONS } from "../utils/constants.js";
import {
  requestRefundSchema,
  approveRefundSchema,
  rejectRefundSchema,
  listRefundsSchema,
  refundIdParamsSchema,
} from "../validators/refundValidators.js";
import {
  requestRefund,
  listMyRefunds,
  getRefund,
  listAll,
  approve,
  reject,
} from "../controllers/refundController.js";

const router = Router();

router.post("/", guestOrderLimiter, optionalAuth, validate({ body: requestRefundSchema }), requestRefund);

router.get("/me", protect, validate({ query: listRefundsSchema }), listMyRefunds);

// Gestión de reembolsos: mismo permiso que el NAV del panel (orders.cancel),
// así admin Y gerente pueden aprobar/rechazar.
router.get("/admin", protect, requirePermission(PERMISSIONS.ORDERS_CANCEL), validate({ query: listRefundsSchema }), listAll);

router.post(
  "/admin/approve",
  protect,
  requirePermission(PERMISSIONS.ORDERS_CANCEL),
  validate({ body: approveRefundSchema }),
  approve
);
router.post(
  "/admin/reject",
  protect,
  requirePermission(PERMISSIONS.ORDERS_CANCEL),
  validate({ body: rejectRefundSchema }),
  reject
);

router.get("/:id", protect, validate({ params: refundIdParamsSchema }), getRefund);

export default router;
