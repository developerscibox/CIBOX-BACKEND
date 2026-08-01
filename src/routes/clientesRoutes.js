import { Router } from "express";

import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { lookupLimiter } from "../middlewares/rateLimiters.js";
import { PERMISSIONS } from "../utils/constants.js";
import { validate } from "../middlewares/validate.js";
import {
  createClienteSchema,
  updateClienteSchema,
  clienteIdSchema,
  abonoClienteSchema,
  buscarRutSchema,
} from "../validators/clienteValidators.js";
import {
  listClientes,
  createCliente,
  updateCliente,
  estadoCuenta,
  abonoCliente,
  buscarPorRut,
} from "../controllers/clientesController.js";

const router = Router();

// Búsqueda por RUT para la cajera (venta a crédito en caja).
router.get(
  "/buscar-rut/:rut",
  lookupLimiter,
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  validate(buscarRutSchema),
  buscarPorRut,
);

router.get("/", protect, requirePermission(PERMISSIONS.REPORTS_READ), listClientes);

router.post(
  "/",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(createClienteSchema),
  createCliente,
);

router.get(
  "/:id/estado-cuenta",
  protect,
  requirePermission(PERMISSIONS.REPORTS_READ),
  validate(clienteIdSchema),
  estadoCuenta,
);

// Abono FIFO sobre las deudas pendientes del cliente (MUEVE DINERO) → permiso de
// caja (orders.pay), no el de solo-lectura de reportes.
router.post(
  "/:id/abono",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  validate(abonoClienteSchema),
  abonoCliente,
);

router.patch(
  "/:id",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(updateClienteSchema),
  updateCliente,
);

export default router;
