import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import {
  solicitarAutorizacionSchema,
  listarAutorizacionesSchema,
  autorizacionDePedidoSchema,
  resolverAutorizacionSchema,
} from "../validators/autorizacionValidators.js";
import {
  solicitarAutorizacion,
  listarAutorizaciones,
  autorizacionDePedido,
  resolverAutorizacion,
} from "../controllers/autorizacionesController.js";

const router = Router();

// La cajera solicita autorización (anular boleta / cambiar precio).
router.post(
  "/solicitar",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  validate(solicitarAutorizacionSchema),
  solicitarAutorizacion,
);

// Bandeja del jefe (dueño/jefes autorizan desde el celular).
router.get(
  "/",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(listarAutorizacionesSchema),
  listarAutorizaciones,
);

// La cajera consulta el estado de SU solicitud para un pedido.
router.get(
  "/pedido/:orderId",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  validate(autorizacionDePedidoSchema),
  autorizacionDePedido,
);

// El jefe aprueba o rechaza (anulación aprobada = cancela el pedido).
router.post(
  "/:id/resolver",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(resolverAutorizacionSchema),
  resolverAutorizacion,
);

export default router;
