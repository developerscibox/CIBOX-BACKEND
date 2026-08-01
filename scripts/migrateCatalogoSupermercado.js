/**
 * Migración one-shot: catálogo mayorista (por tramos) → catálogo de supermercado.
 *
 * Rellena en cada producto los campos que introdujo la Fase 3 a partir de lo que
 * ya existía:
 *   price        ← tier de min_qty = 1 (o pricing.min_price)
 *   pack_size    ← min_qty del tier mayor (si hay tier de caja)
 *   pack_price   ← precio total del pack (precio unitario del tier × pack_size)
 *   sale_unit    ← "unidad" (o "caja" si el producto solo se vendía por caja)
 *   tax          ← afecto al IVA de brand.legal.iva_pct
 *   sku          ← el existente, o uno generado (el pre-save lo hace)
 *
 * Es idempotente: solo toca los productos a los que les falta `price`.
 * Uso:  node scripts/migrateCatalogoSupermercado.js [--dry]
 */
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import Product from "../src/models/Product.js";
import { logger } from "../src/utils/logger.js";

const dry = process.argv.includes("--dry");

const run = async () => {
  await connectDB();

  const productos = await Product.find({
    $or: [{ price: { $exists: false } }, { price: 0 }],
  });

  let migrados = 0;
  let sinPrecio = 0;

  for (const p of productos) {
    const tiers = [...(p.pricing?.tiers || [])].sort((a, b) => a.min_qty - b.min_qty);
    const unidad = tiers.find((t) => Number(t.min_qty) === 1);
    const caja = [...tiers].reverse().find((t) => Number(t.min_qty) > 1);

    // Precio unitario: el tier de unidad; si el producto solo tenía tier de caja,
    // el precio unitario es el de ese tier (ya viene por unidad).
    const price = Number(unidad?.price ?? caja?.price ?? p.pricing?.min_price ?? 0);
    if (!(price > 0)) {
      sinPrecio += 1;
      continue;
    }

    p.price = price;
    if (caja) {
      p.pack_size = Number(caja.min_qty);
      p.pack_price = Math.round(Number(caja.price) * Number(caja.min_qty));
      if (!unidad) p.sale_unit = "caja";
    }
    if (!p.tax?.iva_pct) p.tax = { afecto: true, iva_pct: p.tax?.iva_pct };

    if (!dry) await p.save(); // el pre-save regenera tiers, min_price y SKU
    migrados += 1;
  }

  logger.info(
    { revisados: productos.length, migrados, sin_precio: sinPrecio, dry },
    dry ? "migración catálogo (simulación)" : "migración catálogo aplicada",
  );
  console.log(
    `${dry ? "[dry-run] " : ""}revisados=${productos.length} migrados=${migrados} sin_precio=${sinPrecio}`,
  );

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌ migración fallida:", err.message);
  process.exit(1);
});
