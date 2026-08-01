import mongoose from "mongoose";
import PriceApproval from "../models/PriceApproval.js";
import Product from "../models/Product.js";
import AuditLog from "../models/AuditLog.js";
import { logger } from "../utils/logger.js";
import { cacheClearPrefix } from "../utils/responseCache.js";
import { ConflictError, NotFoundError, BadRequestError } from "../utils/errors.js";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  approvalKeyboard,
  telegramEnabled,
  telegramGroupChatId,
} from "./telegram.js";
import {
  isApprover,
  isBootstrapOpen,
  addApprover,
  removeApprover,
  listApprovers,
} from "./telegramApprovers.js";

const PRODUCTS_CACHE_PREFIX = "products";

// ── Helpers de precio (consistentes con Precios.jsx / Productos.jsx) ───────────
const boxTier = (tiers = []) => {
  const t = tiers.filter((x) => (x.min_qty || 1) > 1);
  return t.length ? t.reduce((a, b) => ((b.min_qty || 0) > (a.min_qty || 0) ? b : a)) : null;
};
const unitTier = (tiers = []) => tiers.find((x) => (x.min_qty || 1) === 1) || tiers[0] || null;
// Precio de venta representativo = el de caja (el menor) si existe, si no el unitario.
const sellPrice = (tiers = []) => {
  const b = boxTier(tiers);
  if (b) return Math.round(Number(b.price) || 0);
  const u = unitTier(tiers);
  return u ? Math.round(Number(u.price) || 0) : 0;
};

const clp = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CL");
const escapeHtml = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fecha = (d) =>
  new Date(d).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Normaliza y valida los tiers propuestos que manda el cliente.
const cleanTiers = (raw) => {
  if (!Array.isArray(raw) || !raw.length) return null;
  const tiers = raw.map((t) => ({
    min_qty: Math.max(1, Math.round(Number(t.min_qty) || 1)),
    price: Math.round(Number(t.price) || 0),
    label: t.label || ((Number(t.min_qty) || 1) === 1 ? "Unidad" : `Caja ${t.min_qty} un`),
  }));
  if (tiers.some((t) => !(t.price > 0))) return null;
  return tiers.sort((a, b) => a.min_qty - b.min_qty);
};

const tiersIguales = (a = [], b = []) => {
  if (a.length !== b.length) return false;
  const key = (t) => `${t.min_qty}:${Math.round(t.price)}`;
  const sa = a.map(key).sort().join("|");
  const sb = b.map(key).sort().join("|");
  return sa === sb;
};

// ── Texto de los mensajes ──────────────────────────────────────────────────────
const lineasCambios = (cambios) =>
  cambios
    .map((c) => `• ${escapeHtml(c.nombre)}: ${clp(c.precio_actual)} → <b>${clp(c.precio_propuesto)}</b>`)
    .join("\n");

const textoPendiente = async (approval) => {
  const s = approval.solicitante || {};
  const partes = [
    "🏷️ <b>Cambio de precio pendiente</b>",
    `Solicita: <b>${escapeHtml(s.nombre || "—")}</b>${s.role ? ` (${escapeHtml(s.role)})` : ""}`,
  ];
  if (approval.motivo) partes.push(`Motivo: ${escapeHtml(approval.motivo)}`);
  partes.push("", lineasCambios(approval.cambios), "", "Toca para resolver:");
  if (await isBootstrapOpen()) {
    partes.push("", "⚠️ <i>Aún no hay aprobadores configurados: cualquiera del grupo puede resolver. Usa /agregar para fijar la lista.</i>");
  }
  return partes.join("\n");
};

const textoResuelto = (approval, { estado, quien, cuando, warnings = [] }) => {
  const cab =
    estado === "aprobada"
      ? `✅ <b>Aprobado</b> por ${escapeHtml(quien)} · ${fecha(cuando)}`
      : estado === "rechazada"
        ? `❌ <b>Denegado</b> por ${escapeHtml(quien)} · ${fecha(cuando)}`
        : `🚫 <b>Cancelado</b> por ${escapeHtml(quien)} · ${fecha(cuando)}`;
  const cuerpo = ["🏷️ Cambio de precio", lineasCambios(approval.cambios)];
  if (warnings.length) cuerpo.push("", warnings.map((w) => `⚠️ ${escapeHtml(w)}`).join("\n"));
  return [cab, "", ...cuerpo].join("\n");
};

// ── Crear solicitud + notificar ────────────────────────────────────────────────
export const createPriceApproval = async ({ items, motivo, solicitante }) => {
  if (!telegramEnabled() || !telegramGroupChatId()) {
    throw new ConflictError(
      "El bot de Telegram no está configurado (falta token o grupo). No se envió la solicitud.",
    );
  }
  if (!Array.isArray(items) || !items.length) {
    throw new BadRequestError("No hay productos para solicitar");
  }

  // Re-snapshotear cada producto desde la BD (no confiar en el cliente para
  // nombre ni precio vigente). El cliente solo aporta los tiers propuestos.
  const cambios = [];
  const productIds = [];
  for (const it of items) {
    const tiersProp = cleanTiers(it.tiers_propuestos);
    if (!tiersProp) throw new BadRequestError("Precios propuestos inválidos");
    const prod = await Product.findById(it.product_id).select("name pricing").lean();
    if (!prod) throw new NotFoundError("Producto no encontrado");
    const tiersActuales = prod.pricing?.tiers || [];
    if (tiersIguales(tiersActuales, tiersProp)) continue; // sin cambio real
    cambios.push({
      product_id: prod._id,
      nombre: prod.name,
      precio_actual: sellPrice(tiersActuales),
      precio_propuesto: sellPrice(tiersProp),
      tiers_actuales: tiersActuales.map((t) => ({ min_qty: t.min_qty, price: t.price, label: t.label })),
      tiers_propuestos: tiersProp,
    });
    productIds.push(prod._id);
  }
  if (!cambios.length) throw new ConflictError("Ninguno de los productos tiene un cambio de precio");

  // Un producto no puede tener dos solicitudes pendientes a la vez.
  const yaPendiente = await PriceApproval.findOne({
    estado: "pendiente",
    "cambios.product_id": mongoose.trusted({ $in: productIds }),
  }).lean();
  if (yaPendiente) {
    const nombres = yaPendiente.cambios
      .filter((c) => productIds.some((id) => String(id) === String(c.product_id)))
      .map((c) => c.nombre);
    throw new ConflictError(
      `Ya hay una solicitud pendiente para: ${nombres.join(", ") || "un producto"}`,
    );
  }

  const approval = await PriceApproval.create({
    cambios,
    motivo: motivo || null,
    solicitante,
    telegram_chat_id: telegramGroupChatId(),
  });

  // Publicar en el grupo. Si el envío falla, borrar la solicitud (no dejar un
  // cambio fantasma que nadie verá ni podrá aprobar).
  try {
    const msg = await sendMessage(await textoPendiente(approval), {
      replyMarkup: approvalKeyboard(String(approval._id)),
    });
    approval.telegram_message_id = msg.message_id;
    approval.telegram_chat_id = String(msg.chat.id);
    await approval.save();
  } catch (e) {
    await PriceApproval.deleteOne({ _id: approval._id });
    logger.error({ err: e.message }, "priceApproval: envío a Telegram falló");
    throw new ConflictError("No se pudo notificar por Telegram. Intenta de nuevo.");
  }

  return approval;
};

// ── Aplicar los precios aprobados a los productos ──────────────────────────────
const aplicarPrecios = async (approval) => {
  const warnings = [];
  for (const c of approval.cambios) {
    const prod = await Product.findById(c.product_id);
    if (!prod) {
      warnings.push(`${c.nombre}: producto ya no existe`);
      continue;
    }
    // Si el precio cambió por otra vía desde que se solicitó, avisar pero aplicar
    // igual (la intención del aprobador es dejarlo en el valor propuesto).
    const vigente = sellPrice(prod.pricing?.tiers || []);
    if (vigente !== c.precio_actual) {
      warnings.push(`${c.nombre}: el precio había cambiado a ${clp(vigente)} desde la solicitud`);
    }
    prod.pricing = prod.pricing || {};
    prod.pricing.tiers = c.tiers_propuestos.map((t) => ({ min_qty: t.min_qty, price: t.price, label: t.label }));
    await prod.save(); // el hook pre-save recalcula pricing.min_price
  }
  cacheClearPrefix(PRODUCTS_CACHE_PREFIX);
  return warnings;
};

// ── Cancelar (solicitante o admin) ─────────────────────────────────────────────
export const cancelPriceApproval = async ({ id, by }) => {
  const approval = await PriceApproval.findOneAndUpdate(
    { _id: id, estado: "pendiente" },
    { $set: { estado: "cancelada", cancelada_por: by, resuelto_en: new Date() } },
    { new: true },
  );
  if (!approval) {
    const existe = await PriceApproval.findById(id).select("_id").lean();
    if (!existe) throw new NotFoundError("Solicitud no encontrada");
    throw new ConflictError("La solicitud ya fue resuelta o cancelada");
  }
  if (approval.telegram_chat_id && approval.telegram_message_id) {
    await editMessageText(
      approval.telegram_chat_id,
      approval.telegram_message_id,
      textoResuelto(approval, { estado: "cancelada", quien: by.nombre || "solicitante", cuando: approval.resuelto_en }),
    );
  }
  AuditLog.create({
    action: "precio.solicitud_cancelada",
    actor: { user_id: by.user_id || null, label: by.nombre || null },
    target: approval.cambios.map((c) => c.nombre).join(", "),
    detail: `Cancelada por el solicitante (${approval.cambios.length} producto/s)`,
  }).catch(() => {});
  return approval;
};

// Nombre legible de quien interactúa por Telegram (reusado por el dispatcher).
export const nombreDe = (from) =>
  [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || `id ${from.id}`;

// Callback de una SOLICITUD DE PRECIO del catálogo (prefijos ap:/dn:).
export const handlePriceApprovalCallback = async (cq) => {
  const data = cq.data || "";
  const m = data.match(/^(ap|dn):([a-f0-9]{24})$/i);
  if (!m) return answerCallbackQuery(cq.id, "Acción no válida");
  const [, verbo, id] = m;
  const aprobar = verbo === "ap";
  const from = cq.from;

  if (!(await isApprover(from.id))) {
    return answerCallbackQuery(cq.id, `⛔ No estás autorizado.\nTu ID de Telegram: ${from.id}`, true);
  }

  const quien = { telegram_id: String(from.id), nombre: nombreDe(from) };
  const cuando = new Date();

  // Claim atómico: solo gana quien la encuentra pendiente (anti doble-tap / carrera).
  const approval = await PriceApproval.findOneAndUpdate(
    { _id: id, estado: "pendiente" },
    { $set: { estado: aprobar ? "aprobada" : "rechazada", resuelto_por: quien, resuelto_en: cuando } },
    { new: true },
  );
  if (!approval) {
    const existe = await PriceApproval.findById(id).select("estado resuelto_por").lean();
    if (!existe) return answerCallbackQuery(cq.id, "La solicitud ya no existe");
    const q = existe.resuelto_por?.nombre;
    return answerCallbackQuery(cq.id, `Ya fue ${existe.estado}${q ? ` por ${q}` : ""}`);
  }

  let warnings = [];
  if (aprobar) {
    try {
      warnings = await aplicarPrecios(approval);
    } catch (e) {
      warnings = [`Error al aplicar: ${e.message}`];
      logger.error({ err: e.message, id }, "priceApproval: aplicar precios falló");
    }
  }

  await editMessageText(
    approval.telegram_chat_id,
    approval.telegram_message_id,
    textoResuelto(approval, { estado: approval.estado, quien: quien.nombre, cuando, warnings }),
  );
  await answerCallbackQuery(cq.id, aprobar ? "✅ Aprobado y aplicado" : "❌ Denegado");

  AuditLog.create({
    action: aprobar ? "precio.aprobado_telegram" : "precio.denegado_telegram",
    actor: { label: quien.nombre },
    target: approval.cambios.map((c) => c.nombre).join(", "),
    detail: `${aprobar ? "Aprobó" : "Denegó"} ${approval.cambios.length} cambio/s de precio vía Telegram`,
  }).catch(() => {});
};

export const handleTelegramCommand = async (message) => {
  const chatId = message.chat.id;
  const from = message.from;
  const [cmdRaw, ...args] = message.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, ""); // quita @nombrebot

  if (cmd === "/id" || cmd === "/start") {
    return sendMessage(
      `Chat ID: <code>${chatId}</code>\nTu ID de Telegram: <code>${from.id}</code>\nNombre: ${escapeHtml(nombreDe(from))}\n\nPega el Chat ID en TELEGRAM_GROUP_CHAT_ID. Un aprobador puede agregarte con:\n<code>/agregar ${from.id} ${escapeHtml(from.first_name || "")}</code>`,
      { chatId },
    );
  }

  if (cmd === "/aprobadores") {
    const lista = await listApprovers();
    const txt = lista.length
      ? lista.map((a) => `• ${escapeHtml(a.nombre || "—")} (<code>${a.telegram_id}</code>)`).join("\n")
      : "No hay aprobadores configurados (modo abierto: cualquiera puede aprobar).";
    return sendMessage(`👥 <b>Aprobadores</b>\n${txt}`, { chatId });
  }

  if (cmd === "/agregar") {
    if (!(await isApprover(from.id)))
      return sendMessage("⛔ Solo un aprobador puede agregar a otro.", { chatId });
    const id = args[0];
    if (!/^\d+$/.test(id || ""))
      return sendMessage("Uso: <code>/agregar &lt;telegram_id&gt; &lt;nombre&gt;</code>", { chatId });
    const nombre = args.slice(1).join(" ") || null;
    await addApprover(id, nombre, from.id);
    return sendMessage(`✅ Aprobador agregado: ${escapeHtml(nombre || id)} (<code>${id}</code>)`, { chatId });
  }

  if (cmd === "/quitar") {
    if (!(await isApprover(from.id)))
      return sendMessage("⛔ Solo un aprobador puede quitar a otro.", { chatId });
    const id = args[0];
    if (!/^\d+$/.test(id || ""))
      return sendMessage("Uso: <code>/quitar &lt;telegram_id&gt;</code>", { chatId });
    await removeApprover(id);
    return sendMessage(`🗑️ Aprobador quitado: <code>${id}</code>`, { chatId });
  }
};
