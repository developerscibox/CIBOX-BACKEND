import { logger } from "../utils/logger.js";
import { createNotification } from "../utils/notification.js";
import {
  buildOrderCreatedTemplate,
  buildOrderStatusTemplate,
  buildPaymentApprovedTemplate,
  folioDe,
} from "../utils/emailTemplates.js";
import { copyCliente } from "../pedidos/estados.js";
import { brand } from "../config/brand.js";

import { sendEmail } from "./emailService.js";
import { sendPushToUser } from "./pushService.js";

/**
 * AVISOS AL CLIENTE POR EL CICLO DE VIDA DEL PEDIDO (correo + push/in-app).
 *
 * Un solo lugar decide qué se le dice al cliente cuando su pedido nace o cambia
 * de estado, y se dispara desde la función que PERSISTE el cambio —nunca desde
 * el controlador— para que avise igual el panel, la bodega, el webhook del
 * courier y los trabajos automáticos. Antes solo avisaba PATCH /orders/admin/
 * :id/status; el botón "Listo" del picking, la toma del pedido, el webhook de
 * Blue Express y las cancelaciones por otros caminos dejaban al cliente a
 * ciegas.
 *
 * Puntos de disparo (uno por transición, SIEMPRE después de que la escritura
 * quedó confirmada, fuera de withTransaction, y en fire-and-forget):
 *  1. creado         orderController.createFromCart / createFromCustomBox
 *                    → notificarPedidoCreado.
 *  2. paid (manual)  orderService.markAsPaid (transferencia / efectivo; cubre
 *                    payCash y transitionOrderStatus→paid). El pago por Webpay
 *                    NO pasa por aquí: paymentController manda "Pago confirmado"
 *                    y paymentService el push, así que no se duplica.
 *  3. preparing      preparationService.aceptarPicking (toma del pedido).
 *  4. ready/shipped  orderService.commitOrderPick (pick confirmado; también
 *                    cuando transitionOrderStatus delega ahí porque el físico
 *                    aún no había salido).
 *  5. plano          orderService.transitionOrderStatus tras order.save():
 *                    preparing, ready/shipped con stock ya comprometido,
 *                    delivered. Cubre seguimientoExternoService y
 *                    adminController.updateOrderStatus. Los estados que delega
 *                    (paid, cancelled, refunded, pick) avisan en la delegada.
 *  6. cancelled      orderService.cancelOrder (panel, cliente, job de expiración).
 *  7. refunded       orderService.refundOrder.
 *  8. webhook        trackingService.processBlueExpressWebhook (shipped /
 *                    delivered informados por el courier).
 *
 * Las funciones NUNCA lanzan: un problema de correo o de push no puede tumbar
 * la operación que ya ocurrió (el pedido ya cambió de estado).
 */

/**
 * Guarda de duplicados. Dos llamadas por el MISMO cambio (un doble clic en el
 * panel, un webhook reintentado) no deben mandar dos correos, así que se
 * recuerda "orderId:status" durante VENTANA_MS. Es best-effort y por proceso:
 * vive en memoria, se pierde al reiniciar y no se comparte entre instancias.
 * Basta para el caso real (la repetición accidental llega en segundos).
 */
const VENTANA_MS = 10 * 60 * 1000;
const MAX_CLAVES = 500;
const avisados = new Map(); // "orderId:status" → Date.now() del aviso

const yaAvisado = (orderId, status) => {
  const clave = `${orderId}:${status}`;
  const ahora = Date.now();
  const previo = avisados.get(clave);
  if (previo && ahora - previo < VENTANA_MS) return true;
  // Reinsertar al final: el Map conserva orden de inserción, así que la primera
  // clave es siempre la más antigua y es la que se bota al pasar el tope.
  avisados.delete(clave);
  avisados.set(clave, ahora);
  while (avisados.size > MAX_CLAVES) {
    avisados.delete(avisados.keys().next().value);
  }
  return false;
};

const idDe = (order) => String(order?._id || order?.id || "");

/**
 * Entrega la plantilla al emailService. Devuelve true cuando había plantilla y
 * destinatario y el correo se entregó al servicio; si el transporte está
 * apagado (EMAIL_TRANSPORT=off) el servicio lo registra y lo descarta, y eso
 * no cuenta como fallo de este módulo.
 */
const enviarCorreo = async ({ order, plantilla }) => {
  const to = String(order?.customer?.email || "").trim();
  if (!to || !plantilla) return false;
  await sendEmail({ to, subject: plantilla.subject, text: plantilla.text, html: plantilla.html });
  return true;
};

/**
 * Título y cuerpo del push / notificación in-app. El título es el mismo que ve
 * el cliente en la web (copyCliente), sin emojis; el cuerpo es corto y lleva
 * el folio para que se reconozca de un vistazo.
 */
const copiaPush = (order, status, { trackingNumber = null, note = null } = {}) => {
  const { titulo } = copyCliente(status, order.delivery_method);
  const folio = `#${folioDe(order)}`;
  const seguimiento = String(trackingNumber || order.shipping?.tracking_number || "").trim();
  const motivo = String(note || "").trim();
  const esRetiro = order.delivery_method === "pickup";
  const cuerpos = {
    paid: `Tu pago del pedido ${folio} fue confirmado. Ya entró a preparación.`,
    preparing: `Estamos preparando tu pedido ${folio}.`,
    ready: esRetiro
      ? `Tu pedido ${folio} está listo para retirar.`
      : `Tu pedido ${folio} está listo para despacho.`,
    shipped: `Tu pedido ${folio} va en camino.${seguimiento ? ` Seguimiento: ${seguimiento}` : ""}`,
    delivered: `Tu pedido ${folio} fue entregado. ¡Gracias por comprar en ${brand.name}!`,
    cancelled: `Tu pedido ${folio} fue anulado.${motivo ? ` Motivo: ${motivo}` : ""}`,
    refunded: `Te devolvimos el dinero del pedido ${folio}.`,
  };
  const body = cuerpos[status];
  if (!body || !titulo) return null;
  return { title: titulo, body };
};

/**
 * Notificación in-app + push, solo para clientes con cuenta (user_id). Ambas
 * ya son seguras por sí mismas (devuelven null en vez de lanzar); el catch es
 * cinturón por si cambian. true = al menos una de las dos quedó entregada.
 */
const avisarEnLaApp = async ({ order, status, copia }) => {
  if (!order.user_id || !copia) return false;
  const data = { orderId: idDe(order), status };
  const [notificacion, push] = await Promise.all([
    createNotification({
      user_id: order.user_id,
      type: "order_status_changed",
      title: copia.title,
      body: copia.body,
      data,
    }).catch(() => null),
    sendPushToUser({ userId: order.user_id, title: copia.title, body: copia.body, data }).catch(
      () => null,
    ),
  ]);
  return Boolean(notificacion || push);
};

/**
 * Correo "Recibimos tu pedido #ABC123" al crear la orden.
 *
 * @returns {Promise<{ email: boolean }>}
 */
export const notificarPedidoCreado = async ({ order } = {}) => {
  const resultado = { email: false };
  try {
    if (!order) return resultado;
    if (yaAvisado(idDe(order), "creado")) return resultado;
    resultado.email = await enviarCorreo({ order, plantilla: buildOrderCreatedTemplate({ order }) });
  } catch (err) {
    logger.warn({ orderId: idDe(order), err: err?.message }, "no se pudo avisar el pedido creado");
  }
  return resultado;
};

/**
 * Aviso por cambio de estado: correo al cliente (si el estado tiene plantilla)
 * y push + in-app (si tiene cuenta). "pending" y los estados desconocidos no
 * dicen nada. Para "paid" con boleta emitida se manda la misma plantilla de
 * pago confirmado que usa Webpay, con los datos del documento.
 *
 * @returns {Promise<{ email: boolean, push: boolean }>}
 */
export const notificarCambioDeEstado = async ({
  order,
  status,
  trackingNumber = null,
  note = null,
  taxDocument = null,
} = {}) => {
  const resultado = { email: false, push: false };
  try {
    if (!order || !status) return resultado;
    const estado = String(status).toLowerCase();

    const plantilla =
      estado === "paid" && taxDocument
        ? buildPaymentApprovedTemplate({ order, taxDocument })
        : buildOrderStatusTemplate({ order, status: estado, trackingNumber, note });
    const copia = copiaPush(order, estado, { trackingNumber, note });
    if (!plantilla && !copia) return resultado;

    if (yaAvisado(idDe(order), estado)) {
      logger.debug({ orderId: idDe(order), status: estado }, "aviso de estado repetido, se omite");
      return resultado;
    }

    resultado.email = await enviarCorreo({ order, plantilla });
    resultado.push = await avisarEnLaApp({ order, status: estado, copia });
  } catch (err) {
    logger.warn(
      { orderId: idDe(order), status, err: err?.message },
      "no se pudo avisar el cambio de estado del pedido",
    );
  }
  return resultado;
};

export default { notificarPedidoCreado, notificarCambioDeEstado };
