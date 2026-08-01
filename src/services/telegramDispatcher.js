import { answerCallbackQuery } from "./telegram.js";
import { handlePriceApprovalCallback, handleTelegramCommand } from "./priceApprovalService.js";

// Único punto de entrada para los updates de Telegram. Enruta por el prefijo del
// callback_data: ap/dn = solicitud de cambio de precio del catálogo. Los comandos
// (/id, /aprobadores, /agregar, /quitar) van al mismo servicio.
export const handleTelegramUpdate = async (update) => {
  if (update.callback_query) {
    const data = update.callback_query.data || "";
    if (/^(ap|dn):/i.test(data)) return handlePriceApprovalCallback(update.callback_query);
    return answerCallbackQuery(update.callback_query.id, "Acción no válida");
  }
  if (update.message?.text?.startsWith("/")) return handleTelegramCommand(update.message);
};
