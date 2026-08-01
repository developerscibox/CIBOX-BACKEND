/**
 * CARGA MANUAL DE VENTAS — venta presencial en bodega.
 *
 * RUTA SUGERIDA (la cablea el CTO en orderRoutes.js, ANTES de '/:id', junto a
 * las demás rutas '/admin/*'):
 *
 *   router.post(
 *     "/admin/manual",
 *     protect,
 *     requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.OPERATOR),
 *     validate(manualOrderSchema),
 *     createManualOrderHandler,
 *   );
 *
 * → POST /api/orders/admin/manual  (protect + requireRole admin,manager,operator)
 *
 * El handler ya está envuelto en asyncHandler. La validación del body se hace
 * con validate(manualOrderSchema) (validators/manualOrderValidators.js); si se
 * cablea ese middleware en la ruta, el body llega ya saneado.
 */
import { asyncHandler } from "../middlewares/errorHandler.js";
import { createManualOrder } from "../services/manualOrderService.js";

const buildActor = (reqUser, fallbackLabel = "bodega") => ({
  user_id: reqUser?.id || null,
  role: reqUser?.role || null,
  label: reqUser?.email || fallbackLabel,
});

const sanitizeOrder = (order) => {
  if (!order) return null;
  if (typeof order.toJSON === "function") return order.toJSON();
  const clone = { ...order };
  delete clone.guest_token_hash;
  return clone;
};

export const createManualOrderHandler = asyncHandler(async (req, res) => {
  const { items, customer, payment_method, status, discountAmount, notes } =
    req.body;

  const order = await createManualOrder({
    items,
    customer,
    payment_method,
    status,
    discountAmount,
    notes,
    by: buildActor(req.user, "bodega"),
  });

  return res.status(201).json({
    success: true,
    data: { order: sanitizeOrder(order) },
  });
});

export default { createManualOrderHandler };
