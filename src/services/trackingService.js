import crypto from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withTransaction } from "../utils/transactions.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { ORDER_STATUS, VALID_TRANSITIONS } from "../utils/constants.js";

import { lineaDeTiempo, avancePct, copyCliente } from "../pedidos/estados.js";
import { notificarCambioDeEstado } from "./notificacionesPedidoService.js";
const getOrderModel = () => {
  if (!mongoose.models.Order) {
    throw new Error("Order model not registered");
  }
  return mongoose.models.Order;
};

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const matchesGuestToken = (order, token) => {
  if (!token) return false;
  // Antes esto miraba también `order.guest_tracking_token_hash`, que NO existe en
  // el esquema: era una rama muerta que solo despistaba. El campo real es
  // `guest_token_hash`, y viene con `select: false` — hay que pedirlo a mano.
  const stored = order.guest_token_hash || null;
  if (!stored) return false;
  try {
    const a = Buffer.from(stored);
    const b = Buffer.from(hashToken(token));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

/** Cuántos caracteres del _id se le muestran al cliente como "folio". */
const LARGO_FOLIO = 6;

/** El folio que ve el cliente en la pantalla de compra exitosa y en su correo. */
const folioDe = (id) => String(id).slice(-LARGO_FOLIO).toUpperCase();

/**
 * El cliente escribe el folio como se le ocurre: "#A1B2C3", "a1 b2 c3", o pega
 * el id completo de 24 que ve en la URL de su pedido. Dejamos solo letras y
 * números en mayúscula y después vemos contra qué calza.
 */
const normalizarFolio = (raw) =>
  String(raw || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

/**
 * El correo se guarda ya normalizado en la base (`customer.email` es
 * `trim: true, lowercase: true` en el modelo), así que basta con normalizar la
 * ENTRADA para que el calce funcione incluso con los pedidos históricos.
 */
const normalizarEmail = (raw) => String(raw || "").trim().toLowerCase();

/**
 * Comparación del correo en tiempo constante. Si comparáramos con `===`, el
 * tiempo de respuesta filtraría cuántos caracteres iniciales acertó quien
 * prueba, y el endpoint se volvería un oráculo para adivinar correos ajenos.
 */
const mismoEmail = (a, b) => {
  if (!a || !b) return false;
  const ha = Buffer.from(crypto.createHash("sha256").update(a).digest("hex"));
  const hb = Buffer.from(crypto.createHash("sha256").update(b).digest("hex"));
  return crypto.timingSafeEqual(ha, hb);
};

/**
 * UN SOLO error, idéntico, para "ese pedido no existe" y para "el correo no
 * coincide". Es la parte más importante de todo esto: si los mensajes se
 * distinguieran, cualquiera podría recorrer folios hasta encontrar los válidos y
 * confirmar de paso el correo de otra persona, sin llegar nunca a ver un pedido.
 */
const errorGenerico = () =>
  new NotFoundError(
    "No encontramos un pedido con ese número y ese correo. Revisa los dos datos: el correo tiene que ser el mismo con el que hiciste la compra."
  );

/**
 * Cuántos pedidos de ese correo se traen para buscar el folio dentro. Se filtra
 * en memoria porque el folio no es un campo del documento; el tope evita que un
 * correo con miles de pedidos convierta la consulta en un problema.
 */
const MAX_PEDIDOS_POR_CORREO = 100;

/**
 * Seguimiento que ve el CLIENTE. Sin PII ni datos internos: el estado, la línea
 * de tiempo del pedido (qué etapa se cumplió y cuándo), el avance, los datos del
 * despacho y qué compró. Nada de nombre, teléfono, RUT ni dirección de entrega:
 * a esta vista se llega sabiendo un folio y un correo, y esos datos no hacen
 * falta para responder la única pregunta que trae el cliente, que es "¿en qué va
 * mi pedido?".
 *
 * Es la lista blanca de la respuesta: si mañana se agrega un campo al pedido o a
 * la línea de tiempo, NO se filtra solo por estar ahí. Hay que sumarlo aquí a
 * mano, y esa es justamente la idea.
 */
const buildPublicTracking = (order) => {
  // La copia depende del tipo de entrega: un pedido "listo" con despacho va a
  // salir a reparto; uno de retiro está esperando que lo pasen a buscar.
  const copy = copyCliente(order.status, order.delivery_method || "delivery");
  return {
    orderId: String(order._id),
    folio: folioDe(order._id),
    status: order.status,
    estado: copy.titulo,
    detalle: copy.detalle,
    // Qué viene después. Es texto fijo de la máquina de estados (no sale del
    // pedido ni de la persona), así que sumarlo a la lista blanca no expone nada.
    siguiente: copy.siguiente,
    delivery_method: order.delivery_method || "delivery",
    avance_pct: avancePct(order),
    // Línea de tiempo: la máquina de estados (pedidos/estados.js) cruzada con el
    // status_history del pedido. Se copian los campos uno por uno para dejar FUERA
    // el `por` que trae lineaDeTiempo(): ese campo publica el NOMBRE de la persona
    // de bodega que ejecutó cada etapa. Es dato del personal, no del pedido, y no
    // tiene por qué llegarle a alguien que solo acertó un folio y un correo.
    timeline: lineaDeTiempo(order).map((paso) => ({
      estado: paso.estado,
      titulo: paso.titulo,
      detalle: paso.detalle,
      cumplido: paso.cumplido,
      actual: paso.actual,
      fecha: paso.fecha,
      ...(paso.anomalo ? { anomalo: true } : {}),
    })),
    created_at: order.created_at || null,
    delivered_at: order.delivered_at || null,
    // Lo que pagó. Es su propia compra y le sirve para reconocer el pedido; los
    // precios línea por línea, en cambio, no se publican.
    total: Number(order.total || 0),
    shipping: {
      carrier: order.shipping?.carrier || null,
      tracking_number: order.shipping?.tracking_number || null,
      shipment_status: order.shipping?.shipment_status || null,
      estimated_delivery: order.shipping?.estimated_delivery || null,
    },
    pickup: order.delivery_method === "pickup"
      ? { location: order.pickup?.location || null, committed_date: order.pickup?.committed_date || null }
      : null,
    items: Array.isArray(order.items)
      ? order.items.map((it) => ({
          name: it.name || "",
          quantity: Number(it.quantity || 0),
        }))
      : [],
  };
};

export const getTrackingByToken = async ({ orderId, token, userId }) => {
  const Order = getOrderModel();
  // OJO con el `.select("+guest_token_hash")`: el campo está declarado con
  // `select: false` en el modelo, así que sin pedirlo a mano llegaba SIEMPRE
  // undefined. Consecuencia: matchesGuestToken salía por "no hay hash guardado"
  // y el seguimiento de invitado devolvía 403 incluso con el token correcto.
  // Estaba muerto desde el día uno, y por eso nadie lo había notado.
  const order = await Order.findById(orderId).select("+guest_token_hash").lean();
  if (!order) throw new NotFoundError("Orden no encontrada");

  let authorized = false;
  if (userId && String(order.user_id || "") === String(userId)) authorized = true;
  if (!authorized && token && matchesGuestToken(order, token)) authorized = true;

  if (!authorized) throw new ForbiddenError("No autorizado para ver tracking");

  return buildPublicTracking(order);
};

/**
 * TERCERA vía de autorización, para el que compró SIN CUENTA y vuelve después
 * desde otro teléfono o con el navegador limpio: número de pedido + el correo
 * con el que compró.
 *
 * Por qué el número de pedido SOLO no basta: el folio son los últimos 6 del
 * ObjectId de Mongo, y esos bytes son un contador que sube de a uno por
 * documento. O sea que los pedidos consecutivos tienen folios consecutivos y se
 * enumeran caminando hacia arriba. Además el folio se lee por encima del hombro
 * o queda en un papel. El correo es el segundo dato que solo el dueño del pedido
 * conoce, y es el que convierte "adivinable" en "hay que saberlo".
 *
 * Esta función NO toca las otras dos vías (sesión del dueño y token de
 * invitado): es aditiva. Quien tiene sesión y es dueño del pedido sigue entrando
 * como siempre, sin que se le vuelva a pedir el correo.
 */
export const lookupPublicTracking = async ({ folio, email }) => {
  const Order = getOrderModel();
  const folioBuscado = normalizarFolio(folio);
  const correo = normalizarEmail(email);

  if (!folioBuscado || !correo) throw errorGenerico();

  // Se busca POR CORREO y no por folio: el folio no existe como campo del
  // documento (se calcula desde el _id), así que filtrarlo en la base exigiría un
  // regex de sufijo sobre toda la colección. El correo sí está indexado
  // (customer.email + created_at, ver Order.js) y una persona tiene pocos
  // pedidos, así que el calce del folio se hace en memoria sobre un puñado.
  const candidatos = await Order.find({ "customer.email": correo })
    .sort({ created_at: -1 })
    .limit(MAX_PEDIDOS_POR_CORREO)
    .lean();

  const coinciden = (Array.isArray(candidatos) ? candidatos : []).filter((o) => {
    // Aceptamos las dos formas: el folio de 6 que le mostramos al comprar, y el
    // id completo de 24 que le queda en la URL del detalle si alguna vez lo vio.
    const id = String(o._id).toUpperCase();
    return folioBuscado === id || folioBuscado === folioDe(o._id);
  });

  // El folio NO es único: no hay campo, ni índice, ni restricción de unicidad, y
  // dos pedidos pueden compartir los mismos 6 caracteres. Los candidatos vienen
  // del más nuevo al más viejo, así que nos quedamos con el más reciente, que es
  // el que la persona está buscando cuando escribe su número.
  const order = coinciden[0] || null;
  if (!order) throw errorGenerico();

  // Cinturón y tirantes: la consulta ya filtró por correo, pero `customer.email`
  // admite null en el esquema (pedidos viejos, o creados desde el WMS). Un pedido
  // sin correo no se le entrega a nadie, y la comparación se hace en tiempo
  // constante para no filtrar por el reloj cuánto se acertó.
  if (!mismoEmail(normalizarEmail(order.customer?.email), correo)) {
    throw errorGenerico();
  }

  return buildPublicTracking(order);
};

export const syncTrackingFromBlueExpress = async (trackingNumber) => {
  if (!trackingNumber) throw new BadRequestError("tracking_number requerido");
  if (!env.BLUEEXPRESS_API_URL || !env.BLUEEXPRESS_API_KEY) {
    logger.warn({ trackingNumber }, "blueexpress.sync.skipped:not_configured");
    return null;
  }
  try {
    const url = `${env.BLUEEXPRESS_API_URL.replace(/\/$/, "")}/tracking/${encodeURIComponent(
      trackingNumber
    )}`;
    const r = await fetch(url, {
      headers: {
        "x-api-key": env.BLUEEXPRESS_API_KEY,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) {
      logger.warn({ status: r.status, trackingNumber }, "blueexpress.sync.failed");
      return null;
    }
    const data = await r.json();
    const Order = getOrderModel();
    const status = data?.status || data?.shipment_status || null;
    if (status) {
      await Order.updateOne(
        { "shipping.tracking_number": trackingNumber },
        { $set: { "shipping.shipment_status": status, "shipping.last_synced_at": new Date() } }
      );
    }
    return data;
  } catch (err) {
    logger.error({ err: { message: err.message }, trackingNumber }, "blueexpress.sync.error");
    return null;
  }
};

export const verifyBlueExpressSignature = ({ rawBody, signature }) => {
  const secret = env.BLUEEXPRESS_API_KEY;
  if (!secret) return false; // sin secret configurado, rechazamos (fail-closed)
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || {}))
    .digest("hex");
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

export const processBlueExpressWebhook = async (body) => {
  const Order = getOrderModel();
  const trackingNumber =
    body?.tracking_number || body?.trackingNumber || body?.guide || null;
  const status = body?.status || body?.shipment_status || null;

  if (!trackingNumber) {
    throw new BadRequestError("tracking_number requerido en el webhook");
  }

  // Si el evento del courier mueve order.status, se anota aquí y se avisa al
  // cliente DESPUÉS de que la transacción quedó confirmada (nunca adentro).
  let aviso = null;

  const resultado = await withTransaction(async (session) => {
    const order = await Order.findOne({
      "shipping.tracking_number": trackingNumber,
    }).session(session);

    if (!order) {
      logger.warn({ trackingNumber }, "blueexpress.webhook.order_not_found");
      return { processed: false, reason: "order_not_found" };
    }

    // Idempotencia: si el shipment_status ya es el mismo, no hacer nada
    if (order.shipping?.shipment_status === status) {
      return { processed: true, idempotent: true, orderId: String(order._id) };
    }

    if (!order.shipping) order.shipping = {};
    order.shipping.shipment_status = status;
    order.shipping.last_event_at = new Date();
    if (!Array.isArray(order.shipping.events)) order.shipping.events = [];
    order.shipping.events.push({
      status,
      at: new Date(),
      raw: body,
    });

    // Solo mutar order.status si la transición es válida según la máquina de
    // estados; si no, registramos el evento de shipping sin tocar order.status.
    const allowedTransitions = VALID_TRANSITIONS[order.status] || [];
    if (
      status === "delivered" &&
      allowedTransitions.includes(ORDER_STATUS.DELIVERED)
    ) {
      order.status = ORDER_STATUS.DELIVERED;
      order.delivered_at = new Date();
      aviso = { order, status: ORDER_STATUS.DELIVERED };
    } else if (
      status === "in_transit" &&
      allowedTransitions.includes(ORDER_STATUS.SHIPPED)
    ) {
      order.status = ORDER_STATUS.SHIPPED;
      order.shipped_at = new Date();
      aviso = { order, status: ORDER_STATUS.SHIPPED, trackingNumber };
    }

    await order.save({ session });

    logger.info(
      {
        order_id: String(order._id),
        trackingNumber,
        status,
        new_order_status: order.status,
      },
      "blueexpress.webhook.processed"
    );

    return { processed: true, orderId: String(order._id), status };
  });

  if (aviso) notificarCambioDeEstado(aviso).catch(() => {});
  return resultado;
};
