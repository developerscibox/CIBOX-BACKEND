// Siembra los SECTORES físicos de bodega (con orden de recorrido) y asigna a cada
// producto su sector por heurística de nombre. Idempotente.
// Uso: node src/scripts/seedSectores.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import Sector from "../models/Sector.js";
import Product from "../models/Product.js";

dotenv.config();

const SECTORES = [
  { nombre: "Lácteos y refrigerados", orden: 1 },
  { nombre: "Abarrotes", orden: 2 },
  { nombre: "Bebidas y licores", orden: 3 },
  { nombre: "Limpieza y aseo", orden: 4 },
  { nombre: "Snacks y confites", orden: 5 },
];

// nombre del producto (lowercase) → sector por palabra clave
const REGLAS = [
  [/leche|yogur|queso|mantequilla|margarina|crema|huevo|refriger/i, "Lácteos y refrigerados"],
  [/bebida|jugo|agua|cerveza|vino|gaseosa|n[eé]ctar|energ|pisco|ron/i, "Bebidas y licores"],
  [/detergente|cloro|jab[oó]n|lavaloza|papel|toalla|shampoo|pasta dental|aseo|limpia|desinfect/i, "Limpieza y aseo"],
  [/galleta|papas|snack|chocolate|dulce|caramelo|ramita|suflito|confite|man[ií]/i, "Snacks y confites"],
];

const clasificar = (nombre = "") => {
  for (const [re, sector] of REGLAS) if (re.test(nombre)) return sector;
  return "Abarrotes"; // por defecto, lo más común en mayorista
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ DB conectada");

  for (const s of SECTORES) {
    await Sector.updateOne({ nombre: s.nombre }, { $set: s }, { upsert: true });
  }
  console.log(`📦 ${SECTORES.length} sectores sembrados`);

  const productos = await Product.find({}).select("_id name location").lean();
  let asignados = 0;
  const conteo = {};
  for (const p of productos) {
    if (p.location?.sector) {
      conteo[p.location.sector] = (conteo[p.location.sector] || 0) + 1;
      continue; // ya tiene sector → no lo piso
    }
    const sector = clasificar(p.name);
    await Product.updateOne({ _id: p._id }, { $set: { "location.sector": sector } });
    conteo[sector] = (conteo[sector] || 0) + 1;
    asignados++;
  }
  console.log(`🏷️  ${asignados} productos asignados a sector (de ${productos.length})`);
  console.log("   distribución:", conteo);
  process.exit(0);
};

run().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
