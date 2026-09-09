import { Router } from "express";

import { optionalAuth } from "../middlewares/authMiddleware.js";
import { validate } from "../middlewares/validate.js";

import {
  previewShipping,
  quoteShipping,
  applyShippingToOrder,
  previewShippingFromItems
} from "../controllers/shippingController.js";

import {
  previewShippingSchema,
  previewShippingFromItemsSchema,
  quoteShippingByOrderSchema,
  applyShippingSchema,
} from "../validators/shippingValidators.js";

const router = Router();

// Preview en base al carrito (público con identidad opcional via x-guest-id)
router.post(
  "/preview",
  optionalAuth,
  validate(previewShippingSchema),
  previewShipping
);

// Preview para la custom box (lista de items directa, sin carrito).
router.post(
  "/preview-items",
  optionalAuth,
  validate(previewShippingFromItemsSchema),
  previewShippingFromItems
);


// Cotización para una orden existente (ownership requerido)
router.post(
  "/quote",
  optionalAuth,
  validate(quoteShippingByOrderSchema),
  quoteShipping
);

// Aplicar el envío a una orden — recalcula monto en servidor
router.post(
  "/apply",
  optionalAuth,
  validate(applyShippingSchema),
  applyShippingToOrder
);

export default router;
