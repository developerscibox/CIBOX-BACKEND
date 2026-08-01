import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { getCierreZ, abrirCaja, cajaActual, cerrarCaja, miDia } from "../controllers/cajaController.js";

const router = Router();

router.get("/cierre-z", protect, requirePermission(PERMISSIONS.REPORTS_READ), getCierreZ);

// Sesión de caja (cajera): abrir con fondo, ver esperado en vivo, cerrar con cuadre.
router.get("/mi-dia", protect, requirePermission(PERMISSIONS.ORDERS_PAY), miDia);
router.get("/sesion/actual", protect, requirePermission(PERMISSIONS.ORDERS_PAY), cajaActual);
router.post("/sesion/abrir", protect, requirePermission(PERMISSIONS.ORDERS_PAY), abrirCaja);
router.patch("/sesion/cerrar", protect, requirePermission(PERMISSIONS.ORDERS_PAY), cerrarCaja);

export default router;
