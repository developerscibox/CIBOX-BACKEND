import { logger } from "../utils/logger.js";
import { startPolling, telegramEnabled } from "../services/telegram.js";
import { seedApproversFromEnv } from "../services/telegramApprovers.js";
import { handleTelegramUpdate } from "../services/telegramDispatcher.js";

// Arranca el bot de Telegram (long-polling). Sin token, no hace nada y devuelve
// un stop() vacío. Se llama desde server.js.
export const startTelegramBot = () => {
  if (!telegramEnabled()) {
    logger.info("Telegram: desactivado (sin TELEGRAM_BOT_TOKEN)");
    return () => {};
  }
  seedApproversFromEnv().catch((e) => logger.warn({ err: e.message }, "seedApprovers falló"));
  const stop = startPolling(handleTelegramUpdate);
  return stop;
};
