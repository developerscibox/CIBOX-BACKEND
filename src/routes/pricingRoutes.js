import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";
import { calculateItemPricingSchema } from "../validators/pricingValidators.js";
import { calculateItemPricingHandler } from "../controllers/pricingController.js";

const router = Router();

// Público (con auth opcional para aplicar descuento cibox_plus si corresponde)
router.get(
  "/calculate",
  optionalAuth,
  validate({ query: calculateItemPricingSchema }),
  calculateItemPricingHandler
);

export default router;
