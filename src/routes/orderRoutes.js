import { Router } from "express";

import { optionalAuth, protect, strictOptionalAuth } from "../middlewares/authMiddleware.js";
import { requirePermission, requireAnyPermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { validate } from "../middlewares/validate.js";
import { guestOrderLimiter, boardLimiter } from "../middlewares/rateLimiters.js";
import { upload } from "../middlewares/upload.js";
import { BadRequestError } from "../utils/errors.js";

import {
  createFromCart,
  createFromCustomBox,
  getMyOrders,
  getOrderById,
  getGuestOrderById,
  cancelMyOrder,
  retryPayment,
  adminCancelOrder,
  adminUpdateOrderStatus,
  adminListOrders,
  adminPickupSummary,
  adminPickupCalendar,
  adminCashSummary,
  adminPayCash,
  attachTransferReceipt,
  getTransferInfo,
  ordersBoard,
  ordersStream,
  zoneBoard,
  zonaListaHandler,
  adminDeleteOrder,
  adminMarkPrinted,
} from "../controllers/orderController.js";
import {
  createFromCartSchema,
  createFromCustomBoxSchema,
  cancelOrderSchema,
  orderIdParamSchema,
  guestOrderLookupSchema,
  retryPaymentSchema,
  adminUpdateStatusSchema,
  adminPayCashSchema,
  transferReceiptSchema,
} from "../validators/orderValidators.js";
import { createManualOrderHandler } from "../controllers/manualOrderController.js";
import { manualOrderSchema } from "../validators/manualOrderValidators.js";
import { takeOrderHandler, findOrderByScanHandler, cobrarHandler, aceptarHandler, asignarHandler, pickersHandler, pickerConfigHandler, pickerFaceHandler, misMetricasHandler, misPedidosHandler, pickHandler, faltanteHandler, listoHandler } from "../controllers/relayOrderController.js";
import { totemIdentificar, totemIdentificarFacial, totemTablero, totemTomar, totemFinalizar } from "../controllers/totemController.js";
import { takeOrderSchema, cobrarSchema } from "../validators/relayOrderValidators.js";


const router = Router();

router.post(
  "/from-cart",
  strictOptionalAuth,   // invitados OK, pero token expirado → 401 para refresh
  validate(createFromCartSchema),
  createFromCart
);

router.post(
  "/from-custom-box",
  protect,
  validate(createFromCustomBoxSchema),
  createFromCustomBox
);

router.get("/me", protect, getMyOrders);

// Tablero PÚBLICO de estado para clientes (sin login). Limiter de tablero
// (polleo continuo desde la pantalla del local).
router.get("/board", boardLimiter, ordersBoard);
// SSE público (en vivo). boardLimiter acota el RITMO de aperturas de conexión por IP
// (mitiga inundación de conexiones); no afecta la duración de una conexión ya abierta.
router.get("/stream", boardLimiter, ordersStream);

// Monitor por ZONA (dueño de área, sin login): cola de SU sector y marcar
// "zona lista". PÚBLICAS con boardLimiter; antes de las rutas /:id genéricas.
router.get("/zone-board", boardLimiter, zoneBoard);
router.post("/zone/:id/lista", boardLimiter, zonaListaHandler);

// TÓTEM de picking (kiosko del bodeguero): identificación por PIN + tomar/finalizar.
// PÚBLICO como los otros kioskos; el PIN autoriza al picker. identificar/tomar/finalizar
// con limiter estricto (anti fuerza bruta de PIN); tablero se pollea → boardLimiter.
router.post("/totem/identificar", guestOrderLimiter, totemIdentificar);
// Identificación por RECONOCIMIENTO FACIAL: el navegador manda el descriptor (128
// floats de face-api.js) y el backend devuelve al picker + su pin para reutilizar el
// flujo existente. Público con guestOrderLimiter (igual que /identificar).
router.post("/totem/identificar-facial", guestOrderLimiter, totemIdentificarFacial);
router.post("/totem/tablero", boardLimiter, totemTablero);
router.post("/totem/tomar", guestOrderLimiter, totemTomar);
router.post("/totem/finalizar", guestOrderLimiter, totemFinalizar);

// Datos bancarios para transferencia (PÚBLICO): la tienda los muestra al
// confirmar la compra y en el detalle del pedido. Solo expone BANK_TRANSFER_INFO.
router.get("/transfer-info", boardLimiter, getTransferInfo);

// ── Rutas de bodega/WMS (deben ir ANTES de /:id para evitar conflictos) ──────
// Autorización por permiso: leer pedidos (todos los roles WMS), cancelar
// (gerente/admin), y transición de estado — el estado destino permitido por
// rol se valida en el controller (operario: preparing/ready; cajero: delivered).
router.get("/admin", protect, requirePermission(PERMISSIONS.ORDERS_READ), adminListOrders);

// Venta manual (presencial): crea una orden que NO pasó por la app, descuenta
// stock y escribe kardex. admin/manager/operator (orders.prepare).
router.post(
  "/admin/manual",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PREPARE),
  validate(manualOrderSchema),
  createManualOrderHandler,
);

// Relay de sala — etapa 1: el vendedor toma el pedido (→POR_PAGAR + boleta).
router.post(
  "/admin/take",
  protect,
  requirePermission(PERMISSIONS.ORDERS_TAKE),
  validate(takeOrderSchema),
  takeOrderHandler,
);

// Perfil del vendedor: SUS métricas e historial (filtrado por su propio user_id).
router.get("/admin/mis-metricas", protect, requirePermission(PERMISSIONS.ORDERS_TAKE), misMetricasHandler);
router.get("/admin/mis-pedidos", protect, requirePermission(PERMISSIONS.ORDERS_TAKE), misPedidosHandler);

// Relay de sala — etapa 2: la cajera escanea la boleta para traer el pedido.
router.get(
  "/admin/by-scan/:codigo",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  findOrderByScanHandler,
);

// Relay de sala — etapa 2: la cajera cobra → PAGADO → cola de picking.
router.post(
  "/admin/:id/cobrar",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  validate(cobrarSchema),
  cobrarHandler,
);

// Impresión central: persiste que la boleta ya se imprimió (printed_at,
// idempotente) — reemplaza el flag en localStorage por-PC.
router.patch(
  "/admin/:id/printed",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PAY),
  adminMarkPrinted,
);

// Relay de sala — etapa 3: el bodeguero acepta el pedido (claim atómico) → EN_PREPARACION.
// El servicio aplica FIFO por segmento (chicos/grandes) + asignación manual antes del claim.
router.post(
  "/admin/:id/aceptar",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PREPARE),
  aceptarHandler,
);
// Asignación manual de picking (súper-admin): selector de pickers + fijar/limpiar
// assigned_to. Perm users.manage (admin/manager).
router.get("/admin/pickers", protect, requirePermission(PERMISSIONS.USERS_MANAGE), pickersHandler);
router.post("/admin/pickers/:id/config", protect, requirePermission(PERMISSIONS.USERS_MANAGE), pickerConfigHandler);
// Registro/baja del rostro del picker para el tótem (descriptores biométricos).
router.post("/admin/pickers/:id/face", protect, requirePermission(PERMISSIONS.USERS_MANAGE), pickerFaceHandler);
router.post("/admin/:id/asignar", protect, requirePermission(PERMISSIONS.USERS_MANAGE), asignarHandler);
// Picking etapa 3: avance persistido, faltante/dañado y cierre de empaque (→ready).
router.patch("/admin/:id/pick", protect, requirePermission(PERMISSIONS.ORDERS_PREPARE), pickHandler);
router.post("/admin/:id/faltante", protect, requirePermission(PERMISSIONS.ORDERS_PREPARE), faltanteHandler);
router.post("/admin/:id/listo", protect, requirePermission(PERMISSIONS.ORDERS_PREPARE), listoHandler);

router.get(
  "/admin/pickup-summary",
  protect,
  requirePermission(PERMISSIONS.ORDERS_READ),
  adminPickupSummary,
);

router.get(
  "/admin/pickup-calendar",
  protect,
  requirePermission(PERMISSIONS.ORDERS_READ),
  adminPickupCalendar,
);

// Consolidado del efectivo cobrado en el día (cuadre de caja). orders.read.
router.get(
  "/admin/cash-summary",
  protect,
  requirePermission(PERMISSIONS.ORDERS_READ),
  adminCashSummary,
);

// Marcar pagada EN EFECTIVO con monto recibido y vuelto. El cajero (orders.deliver)
// cobra en mostrador; operario/gerente/admin también pueden. El estado destino
// (pending→paid) y el cuadre se validan en el servicio.
router.post(
  "/admin/:id/pay-cash",
  protect,
  requireAnyPermission(PERMISSIONS.ORDERS_DELIVER, PERMISSIONS.ORDERS_PREPARE),
  validate(adminPayCashSchema),
  adminPayCash,
);

router.post(
  "/admin/:id/cancel",
  protect,
  requirePermission(PERMISSIONS.ORDERS_CANCEL),
  validate(cancelOrderSchema),
  adminCancelOrder
);

// Eliminar pedido (admin/gerente). Libera/restaura stock si no es terminal.
router.delete(
  "/admin/:id",
  protect,
  requirePermission(PERMISSIONS.ORDERS_CANCEL),
  adminDeleteOrder,
);

router.patch(
  "/admin/:id/status",
  protect,
  requireAnyPermission(
    PERMISSIONS.ORDERS_PREPARE,
    PERMISSIONS.ORDERS_DELIVER,
    PERMISSIONS.ORDERS_CANCEL,
  ),
  validate(adminUpdateStatusSchema),
  adminUpdateOrderStatus,
);
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/guest/:id",
  guestOrderLimiter,
  validate(guestOrderLookupSchema),
  getGuestOrderById
);

router.get(
  "/:id",
  optionalAuth,
  validate(orderIdParamSchema),
  getOrderById
);

router.post(
  "/:id/cancel",
  optionalAuth,
  validate(cancelOrderSchema),
  cancelMyOrder
);

router.post(
  "/:id/retry-payment",
  optionalAuth,
  validate(retryPaymentSchema),
  retryPayment
);

// Cliente adjunta el comprobante de su transferencia manual (orden pendiente).
// Acepta multipart (campo "receipt", imagen ≤5MB) o JSON { receipt_url }
// (compat). Multer corre antes de validate para poblar req.body con los
// campos de texto del multipart (guestToken). Limiter: es una ruta con
// upload accesible por invitados (dueño por x-guest-id / guest token).
// MulterError (p.ej. LIMIT_FILE_SIZE) → 400 legible; el errorHandler global no
// conoce multer y lo respondería como 500.
const uploadReceipt = (req, res, next) =>
  upload.single("receipt")(req, res, (err) => {
    if (err && err.name === "MulterError") {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "La imagen supera el máximo de 5MB"
          : `Error al subir el archivo: ${err.message}`;
      return next(new BadRequestError(msg));
    }
    return next(err);
  });

router.post(
  "/:id/transfer-receipt",
  guestOrderLimiter,
  optionalAuth,
  uploadReceipt,
  validate(transferReceiptSchema),
  attachTransferReceipt
);

export default router;
