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
  adminPayCash,
  attachTransferReceipt,
  getTransferInfo,
  ordersBoard,
  ordersStream,
  adminDeleteOrder,
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
import { aceptarHandler, asignarHandler, pickersHandler, pickHandler, faltanteHandler, listoHandler } from "../controllers/preparationController.js";


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

// Datos bancarios para transferencia (PÚBLICO): la tienda los muestra al
// confirmar la compra y en el detalle del pedido. Solo expone BANK_TRANSFER_INFO.
router.get("/transfer-info", boardLimiter, getTransferInfo);

// ── Rutas de bodega/WMS (deben ir ANTES de /:id para evitar conflictos) ──────
// Autorización por permiso: leer pedidos (todos los roles WMS), cancelar
// (gerente/admin), y transición de estado — el estado destino permitido por
// rol se valida en el controller (operario: preparing/ready; cajero: delivered).
router.get("/admin", protect, requirePermission(PERMISSIONS.ORDERS_READ), adminListOrders);

// Preparación: se toma el pedido pagado (claim atómico) → EN PREPARACIÓN.
// El servicio respeta la asignación manual (assigned_to) antes del claim.
router.post(
  "/admin/:id/aceptar",
  protect,
  requirePermission(PERMISSIONS.ORDERS_PREPARE),
  aceptarHandler,
);
// Asignación manual de la preparación: selector de personas + fijar/limpiar
// assigned_to. Perm users.manage (admin/manager).
router.get("/admin/pickers", protect, requirePermission(PERMISSIONS.USERS_MANAGE), pickersHandler);
router.post("/admin/:id/asignar", protect, requirePermission(PERMISSIONS.USERS_MANAGE), asignarHandler);
// Preparación: avance persistido, faltante/dañado y cierre de empaque (→ready).
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

// Registrar el pago de un pedido contra entrega / transferencia confirmada, con
// monto recibido y vuelto. El estado destino (pending→paid) lo valida el servicio.
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
