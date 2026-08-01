import { Router } from "express";

import { optionalAuth } from "../middlewares/authMiddleware.js";
import { validate } from "../middlewares/validate.js";
import { paymentLimiter } from "../middlewares/rateLimiters.js";

import {
  createWebpayTransaction,
  commitWebpayTransaction,
  handleWebpayReturn,
} from "../controllers/paymentController.js";
import {
  createWebpaySchema,
  commitWebpaySchema,
} from "../validators/paymentValidators.js";

const router = Router();

router.post(
  "/webpay/create",
  paymentLimiter,
  optionalAuth,
  validate(createWebpaySchema),
  createWebpayTransaction
);

router.post(
  "/webpay/commit",
  paymentLimiter,
  optionalAuth,
  validate(commitWebpaySchema),
  commitWebpayTransaction
);

// Endpoint de retorno de Transbank (sin auth, viene del PSP)
router.get("/webpay/return", handleWebpayReturn);
router.post("/webpay/return", handleWebpayReturn);

export default router;
