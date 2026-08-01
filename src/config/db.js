import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

export const connectDB = async () => {
  try {
    await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    logger.info({ uri: env.MONGO_URI.replace(/\/\/.*@/, "//***@") }, "Mongo conectado");
  } catch (err) {
    logger.fatal({ err: err.message }, "No se pudo conectar a Mongo");
    process.exit(1);
  }

  // Las transacciones (withTransaction) requieren replica set o mongos. En
  // standalone, el callback corre SIN atomicidad (sin rollback): un fallo a
  // mitad puede dejar stock/órdenes inconsistentes. En producción es inaceptable.
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const supportsTx = Boolean(hello.setName) || hello.msg === "isdbgrid";
    if (!supportsTx) {
      if (env.isProd) {
        logger.fatal(
          "Mongo NO es replica set/mongos: las transacciones no son atómicas. Abortando en producción.",
        );
        process.exit(1);
      }
      logger.warn(
        "Mongo standalone: withTransaction corre SIN atomicidad (sin rollback). Aceptable solo en dev.",
      );
    } else {
      logger.info({ topology: hello.setName || "mongos" }, "Mongo soporta transacciones");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "No se pudo verificar el modo replica set de Mongo");
  }

  mongoose.connection.on("disconnected", () => logger.warn("Mongo desconectado"));
  mongoose.connection.on("reconnected", () => logger.info("Mongo reconectado"));
  mongoose.connection.on("error", (err) => logger.error({ err }, "Mongo error"));
};
