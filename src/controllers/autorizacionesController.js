import { asyncHandler } from "../middlewares/errorHandler.js";
import Autorizacion from "../models/Autorizacion.js";
import Order from "../models/Order.js";
import { emitRelayChange } from "../utils/relayBus.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { notifyAutorizacionTelegram, resolveAutorizacion } from "../services/autorizacionService.js";

/**
 * Autorizaciones sensibles de caja (anti-robo): anular boleta / cambiar precio.
 * La cajera SOLICITA, el jefe (celular/panel) APRUEBA o RECHAZA. Todo queda
 * registrado e inmutable con el usuario de cada cajera.
 */

// POST /autorizaciones/solicitar (ORDERS_PAY — cajera)
export const solicitarAutorizacion = asyncHandler(async (req, res) => {
  const { order_id, tipo, detalle, cambios: cambiosRaw } = req.body;

  const order = await Order.findById(order_id)
    .select("total status payment.status items")
    .lean();
  if (!order) throw new NotFoundError("Pedido no encontrado");

  // Excepción de PRECIO: solo sobre pedidos aún POR PAGAR, y cada cambio se
  // snapshotea contra el ítem real del pedido (precio vigente, nombre, cantidad).
  let cambios = [];
  if (tipo === "precio") {
    if (order.status !== "pending") {
      throw new ConflictError("El pedido ya fue cobrado: el precio no se puede modificar");
    }
    const porId = new Map((order.items || []).map((it) => [String(it.product_id), it]));
    for (const c of cambiosRaw || []) {
      const it = porId.get(String(c.product_id));
      if (!it) throw new NotFoundError("Uno de los productos no pertenece al pedido");
      const propuesto = Math.round(Number(c.precio_propuesto));
      if (propuesto === Math.round(Number(it.price))) {
        throw new ConflictError(`"${it.name}" ya tiene ese precio`);
      }
      cambios.push({
        product_id: it.product_id,
        name: it.name,
        cantidad: it.quantity,
        precio_actual: Math.round(Number(it.price) || 0),
        precio_propuesto: propuesto,
      });
    }
  }

  // Una sola solicitud pendiente por pedido+tipo (evita spamear al jefe).
  const yaPendiente = await Autorizacion.findOne({
    order_id,
    tipo,
    estado: "pendiente",
  }).lean();
  if (yaPendiente) {
    throw new ConflictError(
      "Ya hay una solicitud pendiente de este tipo para este pedido",
    );
  }

  const autorizacion = await Autorizacion.create({
    tipo,
    order_id,
    folio: String(order._id).slice(-6).toUpperCase(),
    monto: Number(order.total || 0),
    detalle,
    cambios,
    solicitante: {
      user_id: req.user?.id || null,
      label: req.user?.name || req.user?.email || "caja",
      role: req.user?.role || null,
    },
  });

  // Aviso en vivo al panel del jefe (SSE /orders/stream).
  emitRelayChange({ type: "auth", id: String(order_id) });
  // Aviso al grupo de Telegram con botones Aprobar/Rechazar (best-effort: no
  // bloquea la caja si Telegram falla).
  notifyAutorizacionTelegram(autorizacion).catch(() => {});

  res.status(201).json({ success: true, data: { autorizacion } });
});

// GET /autorizaciones?estado=pendiente|todas (USERS_MANAGE — jefe)
export const listarAutorizaciones = asyncHandler(async (req, res) => {
  const { estado } = req.query;
  const filter = estado === "todas" ? {} : { estado: "pendiente" };

  const [items, pendientes] = await Promise.all([
    Autorizacion.find(filter).sort({ created_at: -1 }).limit(50).lean(),
    Autorizacion.countDocuments({ estado: "pendiente" }),
  ]);

  res.json({ success: true, data: { items, pendientes } });
});

// GET /autorizaciones/pedido/:orderId (ORDERS_PAY — la cajera consulta la suya)
export const autorizacionDePedido = asyncHandler(async (req, res) => {
  const autorizacion = await Autorizacion.findOne({
    order_id: req.params.orderId,
  })
    .sort({ created_at: -1 })
    .lean();

  res.json({ success: true, data: { autorizacion: autorizacion || null } });
});

// POST /autorizaciones/:id/resolver (USERS_MANAGE — jefe)
// Reusa el servicio compartido (misma lógica que el callback de Telegram): claim
// atómico + anular pedido / aplicar precios. El resolutor es el usuario del panel.
export const resolverAutorizacion = asyncHandler(async (req, res) => {
  const { aprobar, nota } = req.body;
  const label = req.user?.name || req.user?.email || "jefe";

  const { autorizacion, cancelacionError, aplicacionError } = await resolveAutorizacion({
    id: req.params.id,
    aprobar,
    nota,
    resolutor: { user_id: req.user?.id || null, label },
    actor: { user_id: req.user?.id || null, role: req.user?.role || null, label },
  });

  // Si ya estaba resuelta, el servicio lanza ConflictError (con alreadyResolved);
  // el errorHandler la traduce a 409.

  res.json({
    success: true,
    data: {
      autorizacion,
      ...(cancelacionError ? { cancelacion_error: cancelacionError } : {}),
      ...(aplicacionError ? { aplicacion_error: aplicacionError } : {}),
    },
  });
});
