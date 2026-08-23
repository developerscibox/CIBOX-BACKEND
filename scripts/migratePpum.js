/**
 * scripts/migratePpum.js
 *
 * Rellena el precio por unidad de medida (decreto 38/2024) de todo el catálogo
 * existente. Calcula el PPUM de cada producto con la misma función pura que usa
 * el modelo y escribe los derivados (`ppum.value`, `ppum.unit_label`,
 * `ppum.text`).
 *
 * No inventa datos: los productos cuyo contenido no alcanza quedan sin PPUM y
 * se listan al final para completarlos a mano.
 *
 * Uso:
 *   node scripts/migratePpum.js            # simula, no escribe
 *   node scripts/migratePpum.js --aplicar  # escribe
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { ppumDeProducto, motivoExcepcion, resolverPreset } from "../src/catalogo/ppum.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("❌  MONGO_URI no definida en .env");
  process.exit(1);
}

const aplicar = process.argv.includes("--aplicar");

await mongoose.connect(MONGO_URI);
console.log(`✅  Conectado a MongoDB${aplicar ? "" : "  (simulación: no se escribe nada)"}`);

const products = mongoose.connection.db.collection("products");
const todos = await products.find({}).toArray();

const conPpum = [];
const sinPpum = [];
const operaciones = [];

for (const producto of todos) {
  const ppum = ppumDeProducto(producto);

  const preset = resolverPreset({
    nombre: producto.name,
    categoria: producto.category?.name,
    subcategoria: producto.subcategory?.name,
    piezas: producto.ppum?.pieces_per_pack ?? 0,
  });
  const excepcion = motivoExcepcion({
    contenido: producto.unit_content?.value,
    unidad: producto.unit_content?.unit,
    preset,
  });

  const set = {
    "ppum.value": ppum?.valor || 0,
    "ppum.unit_label": ppum?.etiqueta || "",
    "ppum.text": ppum?.texto || "",
  };

  // Se deja anotado el motivo de excepción detectable (art. 8° n°2), pero NO se
  // marca `mode: "exempt"`: el encargo fue publicar el PPUM en todo lo que se
  // pueda calcular, aunque la norma no lo exija.
  if (excepcion && !producto.ppum?.exempt_reason) set["ppum.exempt_reason"] = excepcion;
  if (!producto.ppum?.mode) set["ppum.mode"] = "auto";

  operaciones.push({ updateOne: { filter: { _id: producto._id }, update: { $set: set } } });

  const fila = {
    nombre: producto.name,
    categoria: producto.category?.name || "—",
    contenido: `${producto.unit_content?.value ?? 0} ${producto.unit_content?.unit ?? ""}`.trim(),
    preset: preset || "—",
    ppum: ppum?.texto || "—",
  };
  (ppum ? conPpum : sinPpum).push(fila);
}

if (aplicar && operaciones.length) {
  const res = await products.bulkWrite(operaciones, { ordered: false });
  console.log(`✍️   Actualizados ${res.modifiedCount} de ${todos.length} productos`);
}

console.table(conPpum);
console.log(`\n📊  Con PPUM: ${conPpum.length} / ${todos.length}`);

if (sinPpum.length) {
  console.log(`\n⚠️   Sin PPUM (${sinPpum.length}) — faltan datos o están exceptuados:`);
  console.table(sinPpum);
}

if (!aplicar) console.log("\nℹ️   Simulación. Corre con --aplicar para escribir.");

await mongoose.disconnect();
