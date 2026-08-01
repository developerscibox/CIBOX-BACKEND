import mongoose from "mongoose";
import Reservation from "../models/Reservation.js";
import { releaseReserved } from "../services/stockService.js";
import { withTransaction } from "../utils/transactions.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Job: libera reservas de carrito vencidas.
 *
 * Cada reserva activa retiene unidades en Product.reserved (DISPONIBLE =
 * stock − reserved). Pasado su TTL hay que devolver esas unidades al pool de
 * disponible. Este job barre las reservas {active, expires_at < now} y, por
 * cada una, en una transacción: marca la Reservation como `released` y
 * decrementa Product.reserved. El stock físico NO se toca.
 *
 * Complementa el lazy release de getCart (que cubre la lectura del propio
 * cliente). Este job cubre carritos abandonados que nadie vuelve a leer.
 *
 * Nota Render free: mientras el server duerme el job no corre; el lazy release
 * en lecturas mitiga reservas zombi, y la pasada inicial al arranque limpia lo
 * acumulado.
 */
export const releaseExpiredReservationsOnce = async () => {
  const stale = await Reservation.find({
    status: "active",
    expires_at: mongoose.trusted({ $lt: new Date() }),
  })
    .select("_id product_id quantity")
    .limit(200)
    .lean();

  if (!stale.length) return { released: 0 };

  let released = 0;
  for (const doc of stale) {
    try {
      await withTransaction(async (session) => {
        // Re-marca dentro de la transacción: si otro proceso (lazy release) ya
        // la liberó, updateOne no afecta filas y no decrementamos de más.
        const res = await Reservation.updateOne(
          { _id: doc._id, status: "active" },
          { $set: { status: "released" } },
          { session: session || null }
        );

        if (res.modifiedCount > 0 && Number(doc.quantity) > 0) {
          await releaseReserved(
            { productId: doc.product_id, qty: Number(doc.quantity) },
            session
          );
        }
      });
      released += 1;
    } catch (err) {
      logger.warn(
        { reservationId: String(doc._id), err: err.message },
        "liberacion: reserva omitida"
      );
    }
  }

  if (released > 0) {
    logger.info({ released }, "liberacion: reservas vencidas liberadas");
  }
  return { released };
};

/**
 * Inicia el job periódico. Devuelve función para detenerlo (shutdown limpio).
 */
export const startReservationReleaseJob = () => {
  const intervalMs = env.CART_RESERVATION_SWEEP_MINUTES * 60 * 1000;

  const timer = setInterval(() => {
    releaseExpiredReservationsOnce().catch((err) =>
      logger.error({ err: err.message }, "liberacion: job falló")
    );
  }, intervalMs);
  timer.unref();

  // Primera pasada al arrancar (limpia lo acumulado si el server estuvo caído).
  releaseExpiredReservationsOnce().catch((err) =>
    logger.error({ err: err.message }, "liberacion: pasada inicial falló")
  );

  logger.info(
    {
      ttl_minutes: env.CART_RESERVATION_TTL_MINUTES,
      sweep_every_minutes: env.CART_RESERVATION_SWEEP_MINUTES,
    },
    "liberacion: job de reservas iniciado"
  );

  return () => clearInterval(timer);
};
