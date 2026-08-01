import { Router } from "express";

import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { guestOrderLimiter } from "../middlewares/rateLimiters.js";
import {
  enviarPedidoHandler,
  estadoExternoHandler,
  sincronizarHandler,
  webhookHandler,
} from "../controllers/seguimientoExternoController.js";

const router = Router();

// ── Seguimiento externo ──────────────────────────────────────────────────────
// El proveedor real todavía no está definido: hoy corre el adapter de log
// (integraciones/SeguimientoPort.js), que registra en log sin llamar a nadie.
// Estas rutas son el contrato estable; cambiar de proveedor no las toca.

// Webhook del proveedor. PÚBLICO por necesidad (lo llama un tercero); la
// autorización es la firma del payload, que valida el adapter. Rate-limit para
// que una ruta pública no sea un vector de inundación.
router.post("/seguimiento/webhook", guestOrderLimiter, webhookHandler);

// Operación interna: enviar el pedido, consultar su estado y forzar la
// sincronización. Mismo permiso que despachar (orders.deliver).
router.get(
  "/seguimiento/pedidos/:id",
  protect,
  requirePermission(PERMISSIONS.ORDERS_READ),
  estadoExternoHandler,
);
router.post(
  "/seguimiento/pedidos/:id",
  protect,
  requirePermission(PERMISSIONS.ORDERS_DELIVER),
  enviarPedidoHandler,
);
router.post(
  "/seguimiento/pedidos/:id/sincronizar",
  protect,
  requirePermission(PERMISSIONS.ORDERS_READ),
  sincronizarHandler,
);

export default router;
