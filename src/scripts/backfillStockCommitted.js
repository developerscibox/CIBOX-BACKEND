import mongoose from "mongoose";
import { env } from "../config/env.js";
import Order from "../models/Order.js";
import { ORDER_STATUS } from "../utils/constants.js";

/**
 * Backfill de UNA SOLA VEZ al desplegar Fase 4 (inventario en 3 estados).
 *
 * Las órdenes creadas con el modelo viejo descontaban el stock FÍSICO al crear
 * la orden (incluso en estado pending). En el modelo nuevo, el físico baja
 * recién en el pick y antes la orden solo tiene stock COMPROMETIDO (allocated).
 *
 * Para que cancelación/reembolso de esas órdenes históricas repongan el físico
 * (y no intenten liberar un allocated que nunca tuvieron), se marca
 * stock_committed=true en toda orden NO terminal (no cancelada/reembolsada).
 *
 * Idempotente: solo toca las que aún no tienen el flag.
 * Ejecutar una vez tras el deploy:  node src/scripts/backfillStockCommitted.js
 */
async function run() {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  // updateMany de Mongoose SÍ pasa por el sanitizeFilter global, así que los
  // operadores van envueltos en mongoose.trusted o el script muere con
  // CastError sin haber tocado un solo pedido.
  const res = await Order.updateMany(
    {
      status: mongoose.trusted({ $nin: [ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED] }),
      stock_committed: mongoose.trusted({ $ne: true }),
    },
    { $set: { stock_committed: true } },
  );

  console.log(
    `Backfill stock_committed: ${res.modifiedCount} órdenes marcadas (de ${res.matchedCount} elegibles).`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill falló:", err.message);
  process.exit(1);
});
