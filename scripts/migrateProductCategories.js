/**
 * scripts/migrateProductCategories.js
 *
 * Migra productos existentes para poblar los campos:
 *   - categories   → array con la categoría primaria
 *   - category_ids → ID de la categoría + todos sus ancestros
 *
 * Ejecutar UNA SOLA VEZ después de desplegar el nuevo modelo:
 *   node scripts/migrateProductCategories.js
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

const db = mongoose.connection.db;
const products  = db.collection("products");
const categories = db.collection("categories");

// Construye mapa de categoría_id → { parent_id, name }
const buildCatMap = async () => {
  const cats = await categories.find({}, { projection: { _id: 1, parent_id: 1, name: 1 } }).toArray();
  const map = new Map();
  for (const c of cats) {
    map.set(String(c._id), {
      parentId: c.parent_id ? String(c.parent_id) : null,
      name: c.name || "",
    });
  }
  return map;
};

// Dado un ID de categoría hoja, devuelve array ordenado de { id, name }
// empezando por el hijo y subiendo hasta la raíz
const resolveChain = (catId, catMap) => {
  const chain = [];
  const ids   = new Set();
  let current = catId;
  let guard   = 0;
  while (current && guard < 10) {
    const entry = catMap.get(current);
    if (!entry) break;
    chain.push({ id: current, name: entry.name });
    ids.add(current);
    current = entry.parentId || null;
    guard++;
  }
  return { chain, ids: Array.from(ids) };
};

const catMap = await buildCatMap();
console.log(`📦  Mapa de categorías cargado: ${catMap.size} categorías`);

// Procesar en lotes
const BATCH = 200;
let skip = 0;
let totalUpdated = 0;
let totalSkipped = 0;

while (true) {
  const batch = await products
    .find({}, { projection: { _id: 1, category: 1, categories: 1, category_ids: 1 } })
    .skip(skip)
    .limit(BATCH)
    .toArray();

  if (batch.length === 0) break;

  const ops = [];
  for (const product of batch) {
    // Saltar solo si categories ya tiene más de 1 item (cadena completa ya resuelta)
    if (Array.isArray(product.categories) && product.categories.length > 1) {
      totalSkipped++;
      continue;
    }

    const primaryId = product.category?.id;
    if (!primaryId) {
      console.warn(`⚠️   Producto ${product._id} sin category.id — omitido`);
      totalSkipped++;
      continue;
    }

    // Resolver cadena: hijo → ... → raíz, con nombres
    const { chain, ids: allIds } = resolveChain(primaryId, catMap);

    ops.push({
      updateOne: {
        filter: { _id: product._id },
        update: {
          $set: {
            categories:   chain,    // [{ id, name: "Aceites y grasas" }, { id, name: "Despensa" }]
            category_ids: allIds,   // ["id-aceites", "id-despensa"]
          },
        },
      },
    });
  }

  if (ops.length > 0) {
    const result = await products.bulkWrite(ops, { ordered: false });
    totalUpdated += result.modifiedCount;
    console.log(`   Lote: ${ops.length} actualizados (acumulado: ${totalUpdated})`);
  }

  skip += BATCH;
}

console.log(`\n✅  Migración completada`);
console.log(`   Productos actualizados: ${totalUpdated}`);
console.log(`   Productos omitidos:     ${totalSkipped}`);

await mongoose.disconnect();
process.exit(0);
