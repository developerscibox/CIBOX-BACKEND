import { Router } from "express";

import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission, requireAnyPermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { validate } from "../middlewares/validate.js";
import { guestOrderLimiter, boardLimiter } from "../middlewares/rateLimiters.js";
import {
  createTurnoSchema,
  pedidosPorRutSchema,
  turnoIdParamSchema,
  callNextSchema,
  moduleCreateSchema,
  moduleUpdateSchema,
  moduleIdParamSchema,
} from "../validators/turnoValidators.js";
import {
  createTurnoPublic,
  turnoBoard,
  turnoStatus,
  pedidosPorRut,
  listTurnos,
  callNext,
  attend,
  done,
  cancel,
  listModules,
  createModule,
  updateModule,
  removeModule,
} from "../controllers/turnoController.js";

const router = Router();

// ── Públicas (cliente vía QR, sin login) ─────────────────────────────────────
// Crear turno: limiter estricto anti-spam (un cliente saca pocos números).
router.post("/", guestOrderLimiter, validate(createTurnoSchema), createTurnoPublic);
// Tablero y seguimiento del turno propio: polleo continuo → limiter de tablero.
router.get("/board", boardLimiter, turnoBoard);
// Kiosko autoatención: pedidos de retiro activos por RUT (limiter estricto; sin PII).
router.get("/pedidos-por-rut/:rut", guestOrderLimiter, validate(pedidosPorRutSchema), pedidosPorRut);

// ── Módulos de atención (config) — ANTES de /:id ─────────────────────────────
// Listar: cualquier rol WMS (Venta Manual elige). Gestionar: admin/gerente.
router.get("/modules", protect, requirePermission(PERMISSIONS.ORDERS_READ), listModules);
router.post(
  "/modules",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(moduleCreateSchema),
  createModule,
);
router.patch(
  "/modules/:id",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(moduleUpdateSchema),
  updateModule,
);
router.delete(
  "/modules/:id",
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate(moduleIdParamSchema),
  removeModule,
);

// ── Vendedor / bodega / CAJA — ANTES de /:id ─────────────────────────────────
// orders.pay incluido: la CAJERA llama su fila (pedidos de internet), atiende,
// cobra y cierra el turno desde su pantalla de Caja.
router.get(
  "/admin",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_TAKE, PERMISSIONS.ORDERS_PREPARE, PERMISSIONS.ORDERS_PAY),
  listTurnos,
);
// Pedidos web por RUT para la CAJA (autenticado): mismo controller que el público del
// kiosko pero SIN guestOrderLimiter — la caja no debe compartir cuota con los kioskos
// de la sala (misma IP tras el NAT) ni quedar bloqueada en plena atención.
router.get(
  "/admin/pedidos-por-rut/:rut",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_TAKE, PERMISSIONS.ORDERS_PREPARE, PERMISSIONS.ORDERS_PAY),
  validate(pedidosPorRutSchema),
  pedidosPorRut,
);
router.post(
  "/admin/call-next",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_TAKE, PERMISSIONS.ORDERS_PREPARE, PERMISSIONS.ORDERS_PAY),
  validate(callNextSchema),
  callNext,
);
router.post(
  "/admin/:id/attend",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_TAKE, PERMISSIONS.ORDERS_PREPARE, PERMISSIONS.ORDERS_PAY),
  validate(turnoIdParamSchema),
  attend,
);
router.post(
  "/admin/:id/done",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_TAKE, PERMISSIONS.ORDERS_PREPARE, PERMISSIONS.ORDERS_PAY),
  validate(turnoIdParamSchema),
  done,
);
router.post(
  "/admin/:id/cancel",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_TAKE, PERMISSIONS.ORDERS_PREPARE, PERMISSIONS.ORDERS_PAY),
  validate(turnoIdParamSchema),
  cancel,
);

// Estado público de un turno (al final, para no chocar con /board ni /admin).
router.get("/:id", boardLimiter, validate(turnoIdParamSchema), turnoStatus);

export default router;
