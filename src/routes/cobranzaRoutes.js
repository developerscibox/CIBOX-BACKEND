import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { getResumen, registrarAbono } from "../controllers/cobranzaController.js";

const router = Router();

router.get("/resumen", protect, requirePermission(PERMISSIONS.REPORTS_READ), getResumen);
// Cobranza accionable: registrar un abono (MUEVE DINERO) → permiso de caja
// (orders.pay), no el de solo-lectura de reportes.
router.patch("/deudas/:id/abono", protect, requirePermission(PERMISSIONS.ORDERS_PAY), registrarAbono);

export default router;
