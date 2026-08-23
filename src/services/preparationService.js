import mongoose from "mongoose";

import Order from "../models/Order.js";
import { ORDER_STATUS } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { NotFoundError, ConflictError } from "../utils/errors.js";

import { transitionOrderStatus } from "./orderService.js";
import { adjustStock } from "./inventoryService.js";
import { emitRelayChange } from "../utils/relayBus.js";

/**
 * PREPARACIÓN DE PEDIDOS (Cibox, 100% online).
 *
 * El pedido llega pagado desde la web y alguien del equipo lo prepara:
 *   paid → preparing (toma) → ready (empacado, aquí SALE el stock físico).
 *
 * Un pedido puede estar asignado a una persona concreta (assigned_to); si no lo
 * está, lo toma quien lo reclame primero. La toma es un claim atómico: dos
 * personas compitiendo por el mismo pedido → una gana, la otra recibe 409.
 */

/**
 * Toma del pedido para prepararlo. CLAIM ATÓMICO condicionado a status='paid'.
 * No toca stock: el físico sale al marcar LISTO (commitPick vía transitionOrderStatus).
 */
export const aceptarPicking = async ({ orderId, by = null }) => {
  const now = new Date();
  const actor = {
    user_id: by?.user_id || null,
    role: by?.role || null,
    label: by?.label || "preparación",
  };

  // Un pedido asignado a otra persona no se puede tomar.
  const target = await Order.findById(orderId).select("assigned_to").lean();
  if (!target) throw new NotFoundError("Pedido no encontrado");
  const assignedId = target.assigned_to?.user_id ? String(target.assigned_to.user_id) : null;
  const actorId = actor.user_id ? String(actor.user_id) : null;
  if (assignedId && assignedId !== actorId) {
    throw new ConflictError(`Este pedido está asignado a ${target.assigned_to.label || "otra persona"}`);
  }

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: ORDER_STATUS.PAID },
    {
      $set: { status: ORDER_STATUS.PREPARING },
      $push: {
        status_history: {
          status: ORDER_STATUS.PREPARING,
          changed_at: now,
          note: `Preparación iniciada por ${actor.label}`,
          changed_by: actor,
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    const exists = await Order.findById(orderId).select("status").lean();
    if (!exists) throw new NotFoundError("Pedido no encontrado");
    throw new ConflictError("Ese pedido ya fue tomado por otra persona");
  }
  logger.info({ orderId: String(updated._id), by: actor.label }, "preparación iniciada (claim atómico)");
  emitRelayChange({ type: "aceptar", id: String(updated._id) });
  return updated;
};

/** Marca/desmarca un ítem como preparado (y si vino por escáner). Persiste el avance. */
export const actualizarPick = async ({ orderId, productId, picked = true, scanned = false }) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Pedido no encontrado");
  const pid = String(productId);
  const prog = new Set((order.pick_progress || []).map(String));
  const scan = new Set((order.pick_scanned || []).map(String));
  if (picked) { prog.add(pid); if (scanned) scan.add(pid); }
  else { prog.delete(pid); scan.delete(pid); }
  order.pick_progress = [...prog];
  order.pick_scanned = [...scan];
  await order.save();
  return order;
};

/** Reporta faltante/dañado de un ítem: registra el faltante, ajusta el inventario
 *  físico a la realidad del estante y marca el pedido para revisión (no lo cancela). */
export const registrarFaltante = async ({ orderId, productId, qtyReal = 0, motivo = "", by = null }) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Pedido no encontrado");
  const pid = String(productId);
  const item = (order.items || []).find((it) => String(it.product_id) === pid);
  const esperado = item ? item.quantity || 0 : 0;
  const real = Math.max(0, Math.round(Number(qtyReal) || 0));

  // Reportar dos veces el mismo faltante NO puede descontar dos veces.
  //
  // ANTES se calculaba faltan = esperado − real contra la cantidad ORIGINAL del
  // pedido en cada llamada, sin mirar si ya había un faltante para ese producto,
  // y se hacía push de otra entrada al arreglo. Como planDeDespacho se queda
  // solo con el ÚLTIMO qty_real, los descuentos anteriores nunca se compensaban:
  // el stock bajaba de más en silencio, y el botón "Falta" del panel sigue
  // habilitado después de reportar, así que era fácil de gatillar.
  //
  // Ahora se ajusta solo la DIFERENCIA contra lo ya registrado, y la entrada del
  // producto se reemplaza en vez de acumularse. Con eso reportar el mismo valor
  // dos veces no mueve nada, y corregir el valor hacia arriba devuelve stock.
  const previo = (order.faltantes || []).find((f) => String(f.product_id) === pid);
  const realPrevio = previo ? Math.max(0, Number(previo.qty_real) || 0) : esperado;
  const ajusteYaAplicado = Math.max(0, esperado - realPrevio);
  const ajusteCorrecto = Math.max(0, esperado - real);
  const delta = ajusteYaAplicado - ajusteCorrecto; // negativo = hay que descontar más

  if (delta !== 0 && item) {
    // Ajuste de inventario: el estante tenía menos de lo que el sistema creía.
    try {
      await adjustStock({ productId: item.product_id, delta, reason: `Faltante preparación #${String(order._id).slice(-6)}: ${motivo || "sin detalle"}`, by });
    } catch { /* el ajuste no debe romper el registro del faltante */ }
  }

  const entrada = { product_id: pid, name: item?.name || "", qty_real: real, motivo: String(motivo || ""), by: by?.label || "preparación", at: new Date() };
  if (previo) {
    order.faltantes = (order.faltantes || []).map((f) =>
      String(f.product_id) === pid ? entrada : f,
    );
  } else {
    order.faltantes.push(entrada);
  }
  order.needs_review = true;
  const prog = new Set((order.pick_progress || []).map(String)); prog.add(pid); // resuelto → permite seguir
  order.pick_progress = [...prog];
  order.status_history.push({ status: order.status, changed_at: new Date(), note: `Faltante: ${item?.name || pid} (real ${real}/${esperado}) — ${motivo || "sin detalle"}`, changed_by: { user_id: by?.user_id || null, role: by?.role || null, label: by?.label || "preparación" } });
  await order.save();
  emitRelayChange({ type: "faltante", id: String(order._id) });
  return order;
};

/** Cierre de empaque + LISTO: guarda nº de bultos/peso y transiciona a ready
 *  (valida VALID_TRANSITIONS y descuenta el físico vía commitOrderPick). */
export const empacarYListo = async ({ orderId, bultos = null, peso = null, by = null }) => {
  await Order.updateOne(
    { _id: orderId },
    { $set: { "packing.bultos": bultos != null ? Math.max(0, Math.round(Number(bultos))) : null, "packing.peso": peso != null ? Math.max(0, Number(peso)) : null } },
  );
  return transitionOrderStatus({
    orderId,
    newStatus: ORDER_STATUS.READY,
    byAdmin: true,
    by,
    note: bultos != null ? `Empacado: ${bultos} bulto${bultos === 1 ? "" : "s"}` : "Listo para despacho",
  });
};

/** Cola de preparación de una persona: pedidos pagados que puede tomar (sin
 *  asignar, o asignados a ella) + los que ya tiene en curso. */
export const colaDePreparacion = async ({ userId = null } = {}) => {
  const uid = userId ? String(userId) : null;
  const paid = await Order.find({ status: ORDER_STATUS.PAID })
    .select("total items customer created_at assigned_to")
    .sort({ created_at: 1 })
    .limit(60)
    .lean();

  const disponibles = paid.filter((o) => {
    const aid = o.assigned_to?.user_id ? String(o.assigned_to.user_id) : null;
    return !aid || aid === uid;
  });

  let enCurso = [];
  if (uid) {
    enCurso = await Order.find({
      status: ORDER_STATUS.PREPARING,
      "assigned_to.user_id": new mongoose.Types.ObjectId(uid),
    })
      .select("total items customer created_at pick_progress")
      .sort({ created_at: 1 })
      .lean();
  }
  return { disponibles, en_curso: enCurso };
};

export default { aceptarPicking, actualizarPick, registrarFaltante, empacarYListo, colaDePreparacion };
