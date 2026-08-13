import app from "./src/app.js";
import { connectDB } from "./src/config/db.js";
import { env } from "./src/config/env.js";
import { logger } from "./src/utils/logger.js";
import { startPendingOrderExpiryJob } from "./src/jobs/expirePendingOrders.js";
import { startReservationReleaseJob } from "./src/jobs/releaseExpiredReservations.js";
import { startKeepWarmJob } from "./src/jobs/keepWarm.js";
import { startTelegramBot } from "./src/jobs/telegramBot.js";

const start = async () => {
  await connectDB();
  const stopExpiryJob = startPendingOrderExpiryJob();
  const stopReservationJob = startReservationReleaseJob();
  const stopKeepWarmJob = startKeepWarmJob();
  const stopTelegramBot = startTelegramBot();
  // Escucha solo en loopback por defecto. Estaba en 0.0.0.0, así que la API
  // quedaba publicada en el puerto 3001 saltándose nginx: sin TLS y, peor, el
  // rate limit del login se podía anular falsificando X-Forwarded-For, porque
  // sin proxy delante el cliente controla esa cabecera. En producción se llega
  // por nginx (443) y no hace falta exponer el puerto.
  //
  // Si algún despliegue necesita exponerlo (contenedor con su propia red), se
  // setea HOST=0.0.0.0 a propósito, no por descuido.
  const host = process.env.HOST || "127.0.0.1";
  const server = app.listen(env.PORT, host, () => {
    logger.info({ host, port: env.PORT, env: env.NODE_ENV }, "Cibox API listening");
  });
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
