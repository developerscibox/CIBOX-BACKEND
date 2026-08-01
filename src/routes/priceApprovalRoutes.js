import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import {
  solicitarCambioPrecioSchema,
  listarCambiosPrecioSchema,
  idParamSchema,
} from "../validators/priceApprovalValidators.js";
import {
  solicitarCambioPrecio,
  listarCambiosPrecio,
  cancelarCambioPrecio,
} from "../controllers/priceApprovalController.js";

const router = Router();

// Todas exigen products.manage (quien puede cambiar precios).
router.post(
  "/",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate(solicitarCambioPrecioSchema),
  solicitarCambioPrecio,
);

router.get(
  "/",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate(listarCambiosPrecioSchema),
  listarCambiosPrecio,
);

router.patch(
  "/:id/cancel",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate(idParamSchema),
  cancelarCambioPrecio,
);

export default router;
