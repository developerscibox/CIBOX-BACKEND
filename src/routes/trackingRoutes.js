import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";
import {
  trackingParamsSchema,
  trackingQuerySchema,
  blueexpressWebhookSchema,
} from "../validators/trackingValidators.js";
import {
  getPublicTracking,
  blueexpressWebhook,
} from "../controllers/trackingController.js";

const router = Router();

router.get(
  "/orders/:id",
  optionalAuth,
  validate({ params: trackingParamsSchema, query: trackingQuerySchema }),
  getPublicTracking
);

router.post(
  "/webhooks/blueexpress",
  validate({ body: blueexpressWebhookSchema }),
  blueexpressWebhook
);

export default router;
