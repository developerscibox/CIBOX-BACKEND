import TelegramApprover from "../models/TelegramApprover.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// Gestión de la lista blanca de aprobadores de Telegram.

// Siembra la lista desde TELEGRAM_APPROVER_IDS (csv). Upsert idempotente: no pisa
// nombres ni el flag activo de los que ya existan.
export const seedApproversFromEnv = async () => {
  const ids = (env.TELEGRAM_APPROVER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    await TelegramApprover.updateOne(
      { telegram_id: id },
      { $setOnInsert: { telegram_id: id, activo: true, agregado_por: "env" } },
      { upsert: true },
    ).catch((e) => logger.warn({ err: e.message, id }, "seedApprovers: upsert falló"));
  }
  const total = await TelegramApprover.countDocuments({ activo: true });
  logger.info({ sembrados: ids.length, activos: total }, "Telegram: lista blanca lista");
};

export const countApprovers = () => TelegramApprover.countDocuments({ activo: true });

/**
 * ¿Puede este telegram_id resolver? Si la lista está VACÍA (nadie configurado),
 * modo bootstrap ABIERTO: cualquiera puede aprobar y agregar aprobadores, hasta
 * que exista al menos uno. Con ≥1 aprobador, se exige estar en la lista activa.
 */
export const isApprover = async (telegramId) => {
  const total = await countApprovers();
  if (total === 0) return true; // bootstrap
  const found = await TelegramApprover.findOne({
    telegram_id: String(telegramId),
    activo: true,
  }).lean();
  return Boolean(found);
};

export const isBootstrapOpen = async () => (await countApprovers()) === 0;

export const addApprover = async (telegramId, nombre, porId) => {
  await TelegramApprover.updateOne(
    { telegram_id: String(telegramId) },
    { $set: { nombre: nombre || null, activo: true }, $setOnInsert: { agregado_por: String(porId || "") } },
    { upsert: true },
  );
};

export const removeApprover = async (telegramId) => {
  await TelegramApprover.updateOne(
    { telegram_id: String(telegramId) },
    { $set: { activo: false } },
  );
};

export const listApprovers = () =>
  TelegramApprover.find({ activo: true }).sort({ created_at: 1 }).lean();
