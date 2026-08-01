/**
 * MÁQUINA DE ESTADOS DEL PEDIDO — lógica pura (sin IO).
 *
 * Un pedido de Cibox recorre este camino desde que el cliente compra hasta que
 * lo recibe:
 *
 *   pending ──► paid ──► preparing ──► ready ──► shipped ──► delivered
 *      │         │           │           │
 *      └─────────┴───────────┴───────────┴──► cancelled
 *                │                                    delivered ──► refunded
 *
 *  pending    El cliente confirmó la compra. El stock quedó RESERVADO y el
 *             pedido espera la confirmación del pago.
 *  paid       Pago confirmado (Webpay, transferencia verificada o contra entrega).
 *             Entra a la cola de preparación.
 *  preparing  Alguien de operaciones lo tomó y lo está armando.
 *  ready      Empacado. Aquí SALE el stock físico de la bodega.
 *  shipped    Salió a reparto.
 *  delivered  El cliente lo recibió. Fin del camino feliz.
 *  cancelled  Anulado antes de entregarse. Repone o libera el stock.
 *  refunded   Devuelto después de entregarse. Repone el stock.
 *
 * Retiro en tienda (`delivery_method: "pickup"`): no hay reparto, así que
 * `ready → delivered` es directo, sin pasar por `shipped`.
 *
 * Esta es la ÚNICA definición de las transiciones válidas. `utils/constants.js`
 * la reexporta para no romper los imports existentes.
 */

export const ORDER_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  PREPARING: "preparing",
  READY: "ready",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
};

/** Estados en los que el pedido ya está pagado (cuenta como venta). */
export const PAID_STATUSES = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.PREPARING,
  ORDER_STATUS.READY,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
];

/** Estados terminales: de aquí no se sale. */
export const TERMINAL_STATUSES = [ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED];

/**
 * Transiciones válidas. Deliberadamente SIN atajos: cada etapa ocurre y queda
 * registrada. `ready → delivered` existe solo para el retiro en tienda y se
 * valida aparte con `puedeTransicionar`.
 */
export const VALID_TRANSITIONS = {
  [ORDER_STATUS.PENDING]: [ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PAID]: [ORDER_STATUS.PREPARING, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED],
  [ORDER_STATUS.PREPARING]: [ORDER_STATUS.READY, ORDER_STATUS.CANCELLED],
  // shipped = despacho a domicilio · delivered = retiro en tienda (ver puedeTransicionar).
  [ORDER_STATUS.READY]: [ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.SHIPPED]: [ORDER_STATUS.DELIVERED],
  [ORDER_STATUS.DELIVERED]: [ORDER_STATUS.REFUNDED],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.REFUNDED]: [],
};

/** Etiqueta para el equipo (panel). */
export const LABELS = {
  [ORDER_STATUS.PENDING]: "Pendiente de pago",
  [ORDER_STATUS.PAID]: "Pagado",
  [ORDER_STATUS.PREPARING]: "En preparación",
  [ORDER_STATUS.READY]: "Listo",
  [ORDER_STATUS.SHIPPED]: "En camino",
  [ORDER_STATUS.DELIVERED]: "Entregado",
  [ORDER_STATUS.CANCELLED]: "Anulado",
  [ORDER_STATUS.REFUNDED]: "Reembolsado",
};

/** Qué le decimos al CLIENTE en cada estado (seguimiento en la web). */
export const CLIENT_COPY = {
  [ORDER_STATUS.PENDING]: {
    titulo: "Esperando tu pago",
    detalle: "Cuando confirmemos el pago empezamos a preparar tu pedido.",
  },
  [ORDER_STATUS.PAID]: {
    titulo: "Pago confirmado",
    detalle: "Tu pedido entró a la cola de preparación.",
  },
  [ORDER_STATUS.PREPARING]: {
    titulo: "Preparando tu pedido",
    detalle: "Estamos armando tu compra en la bodega.",
  },
  [ORDER_STATUS.READY]: {
    titulo: "Pedido listo",
    detalle: "Tu pedido está empacado y listo para salir.",
  },
  [ORDER_STATUS.SHIPPED]: {
    titulo: "En camino",
    detalle: "Tu pedido salió a reparto.",
  },
  [ORDER_STATUS.DELIVERED]: {
    titulo: "Entregado",
    detalle: "Tu pedido llegó a destino. ¡Gracias por comprar en Cibox!",
  },
  [ORDER_STATUS.CANCELLED]: {
    titulo: "Pedido anulado",
    detalle: "Este pedido fue anulado. Si tienes dudas, escríbenos.",
  },
  [ORDER_STATUS.REFUNDED]: {
    titulo: "Pedido reembolsado",
    detalle: "Te devolvimos el dinero de este pedido.",
  },
};

/**
 * ¿Se puede llevar el pedido de `from` a `to`?
 *
 * @param {string} from            estado actual
 * @param {string} to              estado destino
 * @param {object} ctx
 * @param {string} ctx.deliveryMethod  "delivery" | "pickup"
 * @returns {{ok: boolean, motivo?: string}}
 */
export const puedeTransicionar = (from, to, { deliveryMethod = "delivery" } = {}) => {
  if (!VALID_TRANSITIONS[from]) return { ok: false, motivo: `Estado desconocido: ${from}` };
  if (!VALID_TRANSITIONS[from].includes(to)) {
    return { ok: false, motivo: `Transición inválida: ${from} → ${to}` };
  }
  // Un pedido con despacho a domicilio no se marca entregado sin haber salido:
  // saltarse "shipped" deja al cliente sin el aviso de que su pedido va en camino.
  if (from === ORDER_STATUS.READY && to === ORDER_STATUS.DELIVERED && deliveryMethod !== "pickup") {
    return { ok: false, motivo: "Un pedido con despacho debe pasar por 'en camino' antes de entregarse" };
  }
  return { ok: true };
};

/** Estados a los que se puede mover un pedido desde donde está. */
export const siguientesEstados = (from, { deliveryMethod = "delivery" } = {}) =>
  (VALID_TRANSITIONS[from] || []).filter(
    (to) => puedeTransicionar(from, to, { deliveryMethod }).ok,
  );

/** Camino que recorre un pedido según su método de entrega. */
export const caminoDe = (deliveryMethod = "delivery") =>
  deliveryMethod === "pickup"
    ? [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.DELIVERED]
    : [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED];

/**
 * Línea de tiempo del pedido para mostrarle al cliente: cada etapa del camino
 * con si ya ocurrió, cuándo y quién la hizo. Los estados terminales anómalos
 * (anulado / reembolsado) se agregan al final como su propia etapa.
 *
 * @param {object} order  { status, delivery_method, status_history[] }
 */
export const lineaDeTiempo = (order = {}) => {
  const camino = caminoDe(order.delivery_method);
  const historia = Array.isArray(order.status_history) ? order.status_history : [];
  const primeraVez = (estado) => historia.find((h) => h.status === estado) || null;

  const actualIdx = camino.indexOf(order.status);
  const pasos = camino.map((estado, i) => {
    const h = primeraVez(estado);
    return {
      estado,
      titulo: CLIENT_COPY[estado].titulo,
      detalle: CLIENT_COPY[estado].detalle,
      cumplido: Boolean(h) || (actualIdx >= 0 && i <= actualIdx),
      actual: estado === order.status,
      fecha: h?.changed_at || null,
      por: h?.changed_by?.label || null,
    };
  });

  if (TERMINAL_STATUSES.includes(order.status)) {
    const h = primeraVez(order.status);
    pasos.push({
      estado: order.status,
      titulo: CLIENT_COPY[order.status].titulo,
      detalle: CLIENT_COPY[order.status].detalle,
      cumplido: true,
      actual: true,
      fecha: h?.changed_at || null,
      por: h?.changed_by?.label || null,
      anomalo: true,
    });
  }

  return pasos;
};

/** Porcentaje de avance del pedido (0-100), para la barra de seguimiento. */
export const avancePct = (order = {}) => {
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.REFUNDED) return 0;
  const camino = caminoDe(order.delivery_method);
  const i = camino.indexOf(order.status);
  if (i < 0) return 0;
  return Math.round((i / (camino.length - 1)) * 100);
};

export default {
  ORDER_STATUS,
  PAID_STATUSES,
  TERMINAL_STATUSES,
  VALID_TRANSITIONS,
  LABELS,
  CLIENT_COPY,
  puedeTransicionar,
  siguientesEstados,
  caminoDe,
  lineaDeTiempo,
  avancePct,
};
