/**
 * Servicio de seguimiento externo.
 *
 * Conecta la máquina de estados del pedido con el proveedor externo a través
 * del puerto (`integraciones/SeguimientoPort.js`). Todo lo que sabe del
 * proveedor está detrás de ese contrato; aquí solo hay reglas de Cibox.
 *
 * Tres caminos:
 *   1. `enviarPedidoASeguimiento(order)` — cuando el pedido queda listo.
 *   2. `sincronizarEstado(orderId)`      — consulta activa (respaldo del webhook).
 *   3. `procesarWebhook(payload, hdrs)`  — el proveedor nos avisa a nosotros.
 *
 * Regla de oro: **el proveedor informa, la máquina de estados manda.** Un
 * webhook nunca salta una etapa ni resucita un pedido anulado; si el estado que
 * informa no es una transición válida, se guarda como evento y no se aplica.
 */
import mongoose from "mongoose";

import Order from "../models/Order.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { puedeTransicionar } from "../pedidos/estados.js";
import {
  getProveedorSeguimiento,
  ESTADO_PEDIDO_SEGUN_SEGUIMIENTO,
  ESTADOS_SEGUIMIENTO,
} from "../integraciones/SeguimientoPort.js";
import { transitionOrderStatus } from "./orderService.js";

/** Proveedor activo (memoizado: la config no cambia en caliente). */
let _proveedor = null;
export const proveedorActivo = () => {
  if (!_proveedor) {
    _proveedor = getProveedorSeguimiento({
      provider: env.TRACKING_PROVIDER,
      apiUrl: env.TRACKING_API_URL,
      apiKey: env.TRACKING_API_KEY,
      accountId: env.TRACKING_ACCOUNT_ID,
    });
  }
  return _proveedor;
};

/** Traduce un pedido de Cibox a la forma mínima que viaja al proveedor. */
export const construirPedidoParaSeguimiento = (order) => ({
  referencia: String(order._id).slice(-6).toUpperCase(),
  order_id: String(order._id),
  destinatario: {
    nombre: order.customer?.fullName || "",
    telefono: order.customer?.phone || "",
    email: order.customer?.email || "",
  },
  direccion: {
    linea1: order.shipping?.address || "",
    linea2: order.shipping?.addressLine2 || "",
    comuna: order.shipping?.city || "",
    region: order.shipping?.region || "",
    referencia: order.shipping?.reference || "",
  },
  bultos: Array.from({ length: Math.max(1, Number(order.packing?.bultos || 1)) }, (_, i) => ({
    n: i + 1,
    peso_kg: i === 0 ? Number(order.packing?.peso || 0) : 0,
  })),
  total: Number(order.total || 0),
  notas: order.notes || "",
});

/**
 * Envía el pedido al proveedor y guarda la referencia externa.
 * IDEMPOTENTE: si el pedido ya tiene `ref_externa`, no se reenvía.
 * BEST-EFFORT: un proveedor caído nunca puede bloquear la operación de bodega.
 */
export const enviarPedidoASeguimiento = async (orderId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Pedido no encontrado");

  if (order.external_tracking?.ref_externa) {
    return { ya_enviado: true, ...order.external_tracking.toObject?.() ?? order.external_tracking };
  }

  try {
    const res = await proveedorActivo().enviarPedido(construirPedidoParaSeguimiento(order));
    order.external_tracking = {
      proveedor: res.proveedor,
      ref_externa: res.ref_externa,
      estado: res.estado,
      url_seguimiento: res.url_seguimiento || null,
      enviado_at: new Date(),
      ultimo_evento_at: new Date(),
      eventos: [{ estado: res.estado, at: new Date(), detalle: "Pedido enviado al proveedor" }],
    };
    await order.save();
    logger.info(
      { orderId: String(order._id), proveedor: res.proveedor, ref: res.ref_externa },
      "seguimiento externo: pedido enviado",
    );
    return res;
  } catch (err) {
    // No se propaga: el pedido de Cibox ya está listo; el envío al proveedor se
    // reintenta con /reenviar o con la sincronización. Queda en el log.
    logger.error(
      { orderId: String(order._id), err: err.message },
      "seguimiento externo: falló el envío del pedido",
    );
    return { ok: false, error: err.message };
  }
};

/** Consulta activa del estado en el proveedor (respaldo del webhook). */
export const sincronizarEstado = async (orderId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Pedido no encontrado");
  const ref = order.external_tracking?.ref_externa;
  if (!ref) return { ok: false, motivo: "El pedido no está enviado al proveedor" };

  const res = await proveedorActivo().consultarEstado(ref);
  if (res?.estado && res.estado !== ESTADOS_SEGUIMIENTO.DESCONOCIDO) {
    await aplicarEstadoExterno(order, {
      estado: res.estado,
      detalle: "Sincronización activa",
      ocurrido_en: new Date(),
    });
  }
  return res;
};

/**
 * Aplica un estado informado por el proveedor.
 *
 * Siempre deja el evento en el historial externo. Mueve el pedido SOLO si el
 * estado tiene un equivalente interno y la transición es válida según la
 * máquina de estados: el proveedor informa, no gobierna.
 */
export const aplicarEstadoExterno = async (order, { estado, detalle = null, ocurrido_en = null }) => {
  const at = ocurrido_en ? new Date(ocurrido_en) : new Date();

  order.external_tracking = order.external_tracking || {};
  order.external_tracking.estado = estado;
  order.external_tracking.ultimo_evento_at = at;
  order.external_tracking.eventos = [
    ...(order.external_tracking.eventos || []),
    { estado, at, detalle },
  ].slice(-50); // el historial externo no crece sin límite
  await order.save();

  const destino = ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[estado] || null;
  if (!destino || destino === order.status) {
    return { aplicado: false, estado_pedido: order.status };
  }

  const check = puedeTransicionar(order.status, destino, { deliveryMethod: order.delivery_method });
  if (!check.ok) {
    logger.warn(
      { orderId: String(order._id), from: order.status, to: destino, motivo: check.motivo },
      "seguimiento externo: el proveedor informó un estado que no corresponde al pedido — se registra, no se aplica",
    );
    return { aplicado: false, estado_pedido: order.status, motivo: check.motivo };
  }

  const actualizado = await transitionOrderStatus({
    orderId: order._id,
    newStatus: destino,
    byAdmin: true,
    by: { label: `seguimiento:${order.external_tracking.proveedor || "externo"}`, role: "integracion" },
    note: detalle || `Estado informado por el proveedor de seguimiento (${estado})`,
  });
  return { aplicado: true, estado_pedido: actualizado?.status || destino };
};

/**
 * Procesa un webhook del proveedor. La ruta ya validó que el cuerpo llegue;
 * aquí se verifica la firma con el adapter, se traduce y se aplica.
 */
export const procesarWebhook = async ({ payload, headers, rawBody }) => {
  const proveedor = proveedorActivo();

  if (!proveedor.verificarFirma({ payload, headers, rawBody })) {
    throw new BadRequestError("Firma del webhook inválida");
  }

  const evento = await proveedor.normalizarWebhook(payload, headers);
  if (!evento?.ok || !evento.ref_externa) {
    throw new BadRequestError("El webhook no trae una referencia reconocible");
  }

  const order = await Order.findOne({
    "external_tracking.ref_externa": String(evento.ref_externa),
  });
  if (!order) {
    // No es un error del proveedor: puede ser un pedido de otra instalación.
    logger.warn({ ref: evento.ref_externa }, "seguimiento externo: webhook de una referencia desconocida");
    return { ok: true, ignorado: true, motivo: "referencia desconocida" };
  }

  const res = await aplicarEstadoExterno(order, evento);
  return { ok: true, order_id: String(order._id), estado_externo: evento.estado, ...res };
};

/** Estado externo de un pedido (para el panel). */
export const estadoExternoDe = async (orderId) => {
  if (!mongoose.isValidObjectId(orderId)) throw new BadRequestError("id inválido");
  const order = await Order.findById(orderId).select("external_tracking status").lean();
  if (!order) throw new NotFoundError("Pedido no encontrado");
  return {
    proveedor: env.TRACKING_PROVIDER || "log",
    pedido: order.status,
    externo: order.external_tracking || null,
  };
};

export default {
  enviarPedidoASeguimiento,
  sincronizarEstado,
  procesarWebhook,
  estadoExternoDe,
  construirPedidoParaSeguimiento,
};
