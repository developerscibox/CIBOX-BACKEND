import mongoose from "mongoose";
import Autorizacion from "../models/Autorizacion.js";
import Order from "../models/Order.js";
import AuditLog from "../models/AuditLog.js";
import { cancelOrder } from "./orderService.js";
import { emitRelayChange } from "../utils/relayBus.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  telegramEnabled,
  telegramGroupChatId,
} from "./telegram.js";
import { isApprover } from "./telegramApprovers.js";
import { nombreDe } from "./priceApprovalService.js";

// Telegram para las AUTORIZACIONES de caja (anular boleta / cambiar precio de un
// pedido). Reusa el mismo bot/grupo/lista blanca que las solicitudes de precio
// del catálogo. Callbacks con prefijo za: (aprobar) / zd: (rechazar).

const clp = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CL");
const escapeHtml = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fecha = (d) =>
  new Date(d).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const autKeyboard = (id) => ({
  inline_keyboard: [
    [
      { text: "✅ Aprobar", callback_data: `za:${id}` },
      { text: "❌ Rechazar", callback_data: `zd:${id}` },
    ],
  ],
});

const lineasPrecio = (cambios = []) =>
  cambios
    .map((c) => `• ${escapeHtml(c.name)} x${c.cantidad}: ${clp(c.precio_actual)} → <b>${clp(c.precio_propuesto)}</b> c/u`)
    .join("\n");

const textoPendiente = (a) => {
  const s = a.solicitante || {};
  const cab =
    a.tipo === "precio"
      ? "🧾 <b>Autorización de precio (caja)</b>"
      : "🧾 <b>Autorización: ANULAR boleta (caja)</b>";
  const partes = [
    cab,
    `Folio: <b>${escapeHtml(a.folio)}</b> · Monto: ${clp(a.monto)}`,
    `Solicita: <b>${escapeHtml(s.label || "caja")}</b>${s.role ? ` (${escapeHtml(s.role)})` : ""}`,
  ];
  if (a.detalle) partes.push(`Motivo: ${escapeHtml(a.detalle)}`);
  if (a.tipo === "precio" && a.cambios?.length) partes.push("", lineasPrecio(a.cambios));
  partes.push("", "Toca para resolver:");
  return partes.join("\n");
};

const textoResuelto = (a, { estado, quien, cuando, warnings = [] }) => {
  const cab =
    estado === "aprobada"
      ? `✅ <b>Aprobada</b> por ${escapeHtml(quien)} · ${fecha(cuando)}`
      : `❌ <b>Rechazada</b> por ${escapeHtml(quien)} · ${fecha(cuando)}`;
  const tipo = a.tipo === "precio" ? "Cambio de precio" : "Anulación de boleta";
  const cuerpo = [`🧾 ${tipo} · folio ${escapeHtml(a.folio)}`];
  if (a.tipo === "precio" && a.cambios?.length) cuerpo.push(lineasPrecio(a.cambios));
  if (warnings.length) cuerpo.push("", warnings.map((w) => `⚠️ ${escapeHtml(w)}`).join("\n"));
  return [cab, "", ...cuerpo].join("\n");
};

// Publica la autorización en el grupo. Best-effort: si Telegram falla, la caja NO
// se ve afectada (la autorización sigue viva en el panel de Autorizaciones).
export const notifyAutorizacionTelegram = async (autorizacion) => {
  if (!telegramEnabled() || !telegramGroupChatId()) return;
  try {
    const msg = await sendMessage(textoPendiente(autorizacion), {
      replyMarkup: autKeyboard(String(autorizacion._id)),
    });
    await Autorizacion.updateOne(
      { _id: autorizacion._id },
      { $set: { telegram_chat_id: String(msg.chat.id), telegram_message_id: msg.message_id } },
    );
  } catch (e) {
    logger.warn({ err: e.message, folio: autorizacion.folio }, "autorizacion: envío a Telegram falló");
  }
};

/**
 * Resuelve una autorización (aprobar/rechazar) de forma atómica y aplica el
 * efecto: anulación → cancela el pedido; precio → reescribe precios del pedido si
 * sigue por pagar. Reusado por el controller (jefe en el panel) y por el callback
 * de Telegram. `resolutor` = { user_id, label }; `actor` = { user_id, role, label }.
 */
export const resolveAutorizacion = async ({ id, aprobar, nota = null, resolutor, actor }) => {
  const autorizacion = await Autorizacion.findOneAndUpdate(
    { _id: id, estado: "pendiente" },
    { $set: { estado: aprobar ? "aprobada" : "rechazada", resuelto_por: resolutor, resuelto_en: new Date(), nota_resolucion: nota || null } },
    { new: true },
  );
  if (!autorizacion) {
    const existe = await Autorizacion.findById(id).select("estado resuelto_por").lean();
    if (!existe) throw new NotFoundError("Autorización no encontrada");
    const err = new ConflictError("La autorización ya fue resuelta");
    err.alreadyResolved = existe;
    throw err;
  }

  AuditLog.create({
    action: aprobar ? "autorizacion.aprobar" : "autorizacion.rechazar",
    actor,
    target: autorizacion.folio,
    detail: `${autorizacion.tipo}: ${autorizacion.detalle}`,
  }).catch((e) => logger.warn({ err: e.message }, "logAudit autorizacion falló"));

  let cancelacionError = null;
  let aplicacionError = null;

  // Anulación aprobada → cancelar el pedido (repone stock, idempotente).
  if (aprobar && autorizacion.tipo === "anulacion") {
    try {
      await cancelOrder({
        orderId: autorizacion.order_id,
        reason: `Anulación autorizada (folio ${autorizacion.folio}): ${autorizacion.detalle}` + (nota ? ` — ${nota}` : ""),
        byAdmin: true,
        by: { user_id: actor.user_id || null, role: actor.role || null, label: resolutor.label },
      });
      emitRelayChange({ type: "status", id: String(autorizacion.order_id), status: "cancelled" });
    } catch (err) {
      cancelacionError = `La autorización quedó aprobada pero el pedido NO se pudo anular: ${err.message}`;
    }
  }

  // Precio aprobado → aplicar los nuevos precios al pedido si sigue por pagar.
  if (aprobar && autorizacion.tipo === "precio") {
    try {
      const order = await Order.findById(autorizacion.order_id);
      if (!order) throw new Error("pedido no encontrado");
      if (order.status !== "pending" || order.payment?.status === "approved") {
        throw new Error("el pedido ya fue cobrado — el precio no se modificó");
      }
      const porId = new Map((autorizacion.cambios || []).map((c) => [String(c.product_id), c]));
      const nuevosItems = order.items.map((it) => {
        const base = it.toObject ? it.toObject() : { ...it };
        const c = porId.get(String(it.product_id));
        if (!c) return base;
        return { ...base, price: c.precio_propuesto, subtotal: c.precio_propuesto * (it.quantity || 0), discount_applied: true };
      });
      const nuevoSubtotal = nuevosItems.reduce((a, it) => a + (it.subtotal || 0), 0);
      const nuevoTotal = Math.max(0, nuevoSubtotal + (order.shipping_amount || 0) - (order.discount_amount || 0));
      const histEntry = {
        status: order.status,
        changed_at: new Date(),
        note: `Precio ajustado con autorización ${autorizacion.folio} (${resolutor.label})`,
        changed_by: { user_id: actor.user_id || null, role: actor.role || null, label: resolutor.label },
      };
      const updated = await Order.findOneAndUpdate(
        { _id: order._id, status: "pending", "payment.status": mongoose.trusted({ $ne: "approved" }) },
        { $set: { items: nuevosItems, subtotal: nuevoSubtotal, total: nuevoTotal, "payment.amount": nuevoTotal }, $push: { status_history: histEntry } },
        { new: true },
      );
      if (!updated) throw new Error("el pedido ya fue cobrado — el precio no se modificó");
      emitRelayChange({ type: "take", id: String(order._id) });
    } catch (err) {
      aplicacionError = `La autorización quedó aprobada pero el precio NO se aplicó: ${err.message}`;
    }
  }

  emitRelayChange({ type: "auth", id: String(autorizacion.order_id) });
  return { autorizacion, cancelacionError, aplicacionError };
};

// Callback de Telegram para una AUTORIZACIÓN de caja (prefijos za:/zd:).
export const handleAutorizacionCallback = async (cq) => {
  const m = (cq.data || "").match(/^(za|zd):([a-f0-9]{24})$/i);
  if (!m) return answerCallbackQuery(cq.id, "Acción no válida");
  const aprobar = m[1].toLowerCase() === "za";
  const id = m[2];
  const from = cq.from;

  if (!(await isApprover(from.id))) {
    return answerCallbackQuery(cq.id, `⛔ No estás autorizado.\nTu ID de Telegram: ${from.id}`, true);
  }

  const label = nombreDe(from);
  const resolutor = { user_id: null, label };
  const actor = { user_id: null, role: null, label };

  try {
    const { autorizacion, cancelacionError, aplicacionError } = await resolveAutorizacion({ id, aprobar, resolutor, actor });
    const warnings = [cancelacionError, aplicacionError].filter(Boolean);
    if (autorizacion.telegram_chat_id && autorizacion.telegram_message_id) {
      await editMessageText(
        autorizacion.telegram_chat_id,
        autorizacion.telegram_message_id,
        textoResuelto(autorizacion, { estado: autorizacion.estado, quien: label, cuando: autorizacion.resuelto_en, warnings }),
      );
    }
    await answerCallbackQuery(cq.id, aprobar ? "✅ Aprobada" : "❌ Rechazada");
  } catch (e) {
    if (e.alreadyResolved) {
      const q = e.alreadyResolved.resuelto_por?.label;
      return answerCallbackQuery(cq.id, `Ya fue ${e.alreadyResolved.estado}${q ? ` por ${q}` : ""}`);
    }
    logger.error({ err: e.message, id }, "autorizacion: callback falló");
    return answerCallbackQuery(cq.id, "Error: " + e.message);
  }
};
