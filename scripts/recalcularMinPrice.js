/**
 * Rellena `pricing.min_price` en los productos que no lo tienen.
 *
 * POR QUÉ: el catálogo se cargó por migración desde el sitio anterior con
 * `insertMany`/`updateOne`, que NO disparan el `pre("save")` del modelo — y ese
 * hook es el único que calcula `min_price`. Resultado en producción: 761 de 763
 * productos quedaron sin el campo. Como la tienda filtra y ordena por
 * `pricing.min_price`, el filtro "de $X a $Y" devolvía 2 productos de 763 y el
 * orden por precio no ordenaba. La valorización de inventario del panel también
 * quedaba en cero.
 *
 * NO INVENTA NADA: `min_price` es el menor precio de los tramos que el producto
 * ya tiene. Es un valor derivado; si mañana cambian los tramos, se recalcula.
 *
 * Solo escribe `pricing.min_price` con updateOne, que no dispara el
 * `pre("findOneAndUpdate")` que regenera tramos: los precios de venta quedan
 * exactamente como están.
 *
 * Uso:  node scripts/recalcularMinPrice.js          (simulación, no escribe)
 *       node scripts/recalcularMinPrice.js --aplicar
 */
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";

const APLICAR = process.argv.includes("--aplicar");

const main = async () => {
  await connectDB();
  const col = mongoose.connection.db.collection("products");

  const total = await col.countDocuments();
  const productos = await col
    .find({}, { projection: { _id: 1, name: 1, pricing: 1, price: 1 } })
    .toArray();

  let aCorregir = 0;
  let yaCorrectos = 0;
  let sinTramos = 0;
  const ejemplos = [];
  const ops = [];

  for (const p of productos) {
    const tramos = (p.pricing?.tiers || []).filter((t) => Number(t?.price) > 0);
    if (!tramos.length) {
      sinTramos++;
      continue;
    }
    const menor = Math.min(...tramos.map((t) => Number(t.price)));
    const actual = Number(p.pricing?.min_price || 0);

    if (actual === menor) {
      yaCorrectos++;
      continue;
    }
    aCorregir++;
    if (ejemplos.length < 5) {
      ejemplos.push(`${(p.name || "").slice(0, 44)} · ${actual || "vacío"} → ${menor}`);
    }
    ops.push({
      updateOne: {
        filter: { _id: p._id },
        update: { $set: { "pricing.min_price": menor } },
      },
    });
  }

  console.log(`\n  productos en la base:      ${total}`);
  console.log(`  ya tenían el valor bien:   ${yaCorrectos}`);
  console.log(`  sin tramos (no aplica):    ${sinTramos}`);
  console.log(`  a corregir:                ${aCorregir}`);
  if (ejemplos.length) {
    console.log("\n  ejemplos:");
    ejemplos.forEach((e) => console.log(`    · ${e}`));
  }

  if (!APLICAR) {
    console.log("\n  SIMULACIÓN — no se escribió nada. Para aplicar: --aplicar\n");
  } else if (ops.length) {
    const r = await col.bulkWrite(ops, { ordered: false });
    console.log(`\n  ✓ actualizados: ${r.modifiedCount}\n`);
  } else {
    console.log("\n  nada que hacer\n");
  }

  await mongoose.disconnect();
};

main().catch(async (e) => {
  console.error("✗", e);
  await mongoose.disconnect();
  process.exit(1);
});
