/**
 * scripts/migrateSearchNames.js
 *
 * Normaliza el campo search_name de todos los productos existentes
 * para que la búsqueda sea insensible a tildes y mayúsculas.
 *
 * Ejecutar UNA SOLA VEZ después de reiniciar el backend:
 *   node scripts/migrateSearchNames.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("❌  MONGO_URI no definida en .env");
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log("✅  Conectado a MongoDB");

const normalizeText = (str) =>
  String(str ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const products = mongoose.connection.db.collection("products");

const BATCH = 500;
let skip = 0;
let updated = 0;

while (true) {
  const batch = await products
    .find({}, { projection: { _id: 1, name: 1, search_name: 1 } })
    .skip(skip)
    .limit(BATCH)
    .toArray();

  if (!batch.length) break;

  const ops = batch.map((p) => ({
    updateOne: {
      filter: { _id: p._id },
      update: { $set: { search_name: normalizeText(p.name || "") } },
    },
  }));

  const result = await products.bulkWrite(ops, { ordered: false });
  updated += result.modifiedCount;
  console.log(`   Lote procesado: ${result.modifiedCount} actualizados (total: ${updated})`);

  skip += BATCH;
}

console.log(`\n✅  Migración completada — ${updated} productos actualizados`);
await mongoose.disconnect();
process.exit(0);
