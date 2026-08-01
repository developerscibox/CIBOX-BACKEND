import app from "./src/app.js";
import { connectDB } from "./src/config/db.js";
import { env } from "./src/config/env.js";
import { logger } from "./src/utils/logger.js";
import { startPendingOrderExpiryJob } from "./src/jobs/expirePendingOrders.js";
import { startReservationReleaseJob } from "./src/jobs/releaseExpiredReservations.js";
import { startKeepWarmJob } from "./src/jobs/keepWarm.js";
import { ensureRelaySeed } from "./src/jobs/ensureRelaySeed.js";
import { startTelegramBot } from "./src/jobs/telegramBot.js";

const start = async () => {
  await connectDB();
  const stopExpiryJob = startPendingOrderExpiryJob();
  const stopReservationJob = startReservationReleaseJob();
  const stopKeepWarmJob = startKeepWarmJob();
  const stopTelegramBot = startTelegramBot();
  const server = app.listen(env.PORT, "0.0.0.0", () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "Cibox API listening");
  });
  // Producción: asegura sectores del relay + clasificación de productos sin bloquear
  // el arranque. NO crea pedidos demo ni cuentas con contraseña por defecto; el
  // bootstrap de usuarios requiere SEED_RELAY_USERS + SEED_RELAY_PASSWORD explícitos.
  if (env.NODE_ENV === "production") ensureRelaySeed();

  const shutdown = (signal) => {
    logger.info({ signal }, "Shutting down");
    stopExpiryJob();
    stopReservationJob();
    stopKeepWarmJob();
    stopTelegramBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => logger.fatal({ err }, "uncaughtException"));
  process.on("unhandledRejection", (err) => logger.fatal({ err }, "unhandledRejection"));
};

start();
