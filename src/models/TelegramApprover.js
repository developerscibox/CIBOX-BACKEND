import mongoose from "mongoose";

/**
 * Lista blanca de aprobadores de Telegram. Solo estos IDs pueden Aceptar/Denegar
 * cambios de precio desde el grupo. Se siembra desde TELEGRAM_APPROVER_IDS y se
 * edita con los comandos /agregar y /quitar del bot.
 */
const telegramApproverSchema = new mongoose.Schema(
  {
    telegram_id: { type: String, required: true, unique: true, index: true },
    nombre: { type: String, default: null },
    activo: { type: Boolean, default: true },
    agregado_por: { type: String, default: null }, // telegram_id o "env"
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

export const TelegramApprover =
  mongoose.models.TelegramApprover ||
  mongoose.model("TelegramApprover", telegramApproverSchema);
export default TelegramApprover;
