import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// Cliente de bajo nivel del Bot API de Telegram + bucle de long-polling.
// SIN lógica de negocio: solo habla con la API. La lógica (aprobar/denegar,
// comandos) vive en priceApprovalService.handleTelegramUpdate.

const TOKEN = env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// El bot está activo solo si hay token. Sin token, el módulo queda desactivado
// y la pantalla de Precios sigue funcionando en modo directo.
export const telegramEnabled = () => Boolean(TOKEN);
export const telegramGroupChatId = () => env.TELEGRAM_GROUP_CHAT_ID || null;

async function call(method, body) {
  if (!API) throw new Error("Telegram no configurado (falta TELEGRAM_BOT_TOKEN)");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`Telegram ${method} falló: ${json.description || res.status}`);
  }
  return json.result;
}

// Botonera Aceptar/Denegar para una solicitud.
export const approvalKeyboard = (approvalId) => ({
  inline_keyboard: [
    [
      { text: "✅ Aceptar", callback_data: `ap:${approvalId}` },
      { text: "❌ Denegar", callback_data: `dn:${approvalId}` },
    ],
  ],
});

// Envía un mensaje al grupo (o al chat indicado). Devuelve el message result.
export const sendMessage = (text, { chatId, replyMarkup } = {}) =>
  call("sendMessage", {
    chat_id: chatId || telegramGroupChatId(),
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });

// Reemplaza el texto de un mensaje ya publicado (quita botones por defecto).
export const editMessageText = (chatId, messageId, text, replyMarkup = null) =>
  call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup || undefined,
  }).catch((e) => logger.warn({ err: e.message }, "editMessageText falló"));

// Responde el "loading" del botón (toast que ve quien tocó). show_alert = popup.
export const answerCallbackQuery = (id, text, showAlert = false) =>
  call("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert }).catch(
    (e) => logger.warn({ err: e.message }, "answerCallbackQuery falló"),
  );

// ── Long-polling ──────────────────────────────────────────────────────────────
let polling = false;

const getUpdates = (offset) =>
  call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });

/**
 * Arranca el bucle de long-polling. `onUpdate(update)` recibe cada update.
 * Descarta el backlog previo al arranque (offset=-1) para no re-procesar toques
 * o comandos viejos que quedaron en cola.
 */
export const startPolling = (onUpdate) => {
  if (!telegramEnabled()) {
    logger.warn("Telegram: sin TELEGRAM_BOT_TOKEN — bot desactivado");
    return () => {};
  }
  polling = true;
  let offset = 0;

  (async () => {
    // Saltar el backlog: pedir el último update (timeout 0 = sin long-poll, para
    // no demorar el arranque) y arrancar desde el siguiente.
    try {
      const last = await call("getUpdates", { offset: -1, timeout: 0 });
      if (last.length) offset = last[last.length - 1].update_id + 1;
    } catch (e) {
      logger.warn({ err: e.message }, "Telegram: no se pudo leer el backlog inicial");
    }
    logger.info({ group: telegramGroupChatId() || "(sin grupo)" }, "Telegram: polling iniciado");

    while (polling) {
      try {
        const updates = await getUpdates(offset);
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await onUpdate(u);
          } catch (e) {
            logger.error({ err: e.message, update_id: u.update_id }, "Telegram: error procesando update");
          }
        }
      } catch (e) {
        // Errores de red / API: esperar un poco y reintentar (no matar el bucle).
        logger.warn({ err: e.message }, "Telegram: getUpdates falló, reintentando");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    logger.info("Telegram: polling detenido");
  })();

  return () => {
    polling = false;
  };
};
