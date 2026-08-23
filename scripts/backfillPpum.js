/**
 * scripts/backfillPpum.js
 *
 * Rellena `unit_content` del catálogo heredado leyendo la medida que ya viene
 * escrita en el NOMBRE del producto, y con eso calcula el precio por unidad de
 * medida (decreto 38/2024).
 *
 * Por qué desde el nombre: el catálogo real se cargó sin `unit_content`, pero
 * los nombres traen el formato ("GALLETA AGUA COSTA 175G", "ACEITE MARAVILLA
 * 900 ML"). Es el mismo dato que el cliente lee en la ficha, así que no se
 * está inventando nada: se está normalizando lo que ya se publica.
 *
 * Dos formas de nombre:
 *  1. Con cantidad explícita  → "…175G", "…900 ML", "…1,5 LT", "…12 UN".
 *  2. Terminados en K o L solos → formato kilo/litro ("PAN RALLADO K",
 *     "VINAGRE BLANCO RICO L"). Se toma como 1 kg / 1 L, que da el mismo PPUM
 *     tanto si es granel (art. 5°) como si es un envase de un kilo o un litro.
 *
 * Lo que NO se puede leer queda intacto y se lista al final para cargarlo a
 * mano: preferimos un producto sin PPUM antes que un PPUM inventado.
 *
 * Uso:
 *   node scripts/backfillPpum.js              # simula, no escribe
 *   node scripts/backfillPpum.js --aplicar    # escribe
 *   node scripts/backfillPpum.js --detalle    # lista además cada producto
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { ppumDeProducto } from "../src/catalogo/ppum.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("❌  MONGO_URI no definida en .env");
  process.exit(1);
}

const aplicar = process.argv.includes("--aplicar");
const detalle = process.argv.includes("--detalle");

// Unidades tal como aparecen escritas en los nombres del catálogo, con la
// unidad canónica a la que corresponden.
const UNIDADES = [
  [/^(KGS?|KILOS?|KLS?|K)$/, "kg"],
  [/^(GRS?|GRAMOS?|G)$/, "g"],
  [/^MG$/, "mg"],
  // Longitud solo la usa el patron NxM de los rollos. Suelta en el nombre,
  // "25 CM" es el diametro de la tortilla, no su contenido.
  [/^(MTS?|METROS?|M)$/, "m"],
  [/^CM$/, "cm"],
  [/^(LTS?|LITROS?|L)$/, "L"],
  [/^(ML|CC)$/, "ml"],
  [/^(UN|U|UNID|UNIDADES?|PZAS?|PIEZAS?)$/, "un"],
  [/^ROLLOS?$/, "rollos"],
  [/^DOC(ENAS?)?$/, "docena"],
];

const unidadCanonica = (bruta) => {
  const u = String(bruta).toUpperCase();
  for (const [patron, canonica] of UNIDADES) if (patron.test(u)) return canonica;
  return "";
};

// Prioridad de magnitud: masa y volumen mandan sobre conteo. Un
// "ALFAJOR 700G 100U" se compara mejor por kilo que por unidad, y el art. 7°
// pide justamente que todos los de su tipo usen la misma unidad.
const PRIORIDAD = { kg: 3, g: 3, mg: 3, L: 3, ml: 3, rollos: 1, un: 1, docena: 1 };

// Un nombre con medida Y conteo es ambiguo y NO se resuelve solo:
// "KETCHUP SACHET 8G X500U" son 500 sachets de 8 g (multiplica), pero
// "PAN HAMBURGUESA 650G 8 U" son 8 panes que pesan 650 g en total (no
// multiplica). Publicar el caso equivocado sería publicar un precio legal
// falso, así que estos quedan para carga manual.
const ES_MASA_O_VOLUMEN = (u) => ["kg", "g", "mg", "L", "ml"].includes(u);
const ES_CONTEO = (u) => ["un", "docena", "rollos"].includes(u);

const MEDIDA = /(\d+(?:[.,]\d+)?)\s*(KGS?|KILOS?|KLS?|K|GRS?|GRAMOS?|G|MG|LTS?|LITROS?|L|ML|CC|UNIDADES?|UNID|UN|U|PZAS?|PIEZAS?|ROLLOS?|DOC(?:ENAS?)?)(?![A-Z])/gi;

// Letra de formato suelta, sin número: "PAN RALLADO K", "AJO CABEZA U",
// "CEREAL CORNFLAKES K ECONOMICO". Solo se consulta cuando el nombre no trae
// ninguna medida con número, así que el riesgo de confundirla con una inicial
// de marca es bajo — y la simulación deja revisar el resultado antes de escribir.
const FORMATO_SUELTO = /(?:^|\s)(KGS?|KL|K|LTS?|L|UN|U)(?:\s|$)/i;

/**
 * Contenido leído del nombre del producto.
 * @returns {{value:number, unit:string, origen:string}|null}
 */
export const contenidoDesdeNombre = (nombre) => {
  const texto = String(nombre || "").trim().toUpperCase();
  if (!texto) return null;

  // "6X300M", "4X50MT", "12X500CC": N piezas de M cada una. Acá no hay
  // ambiguedad — la N y la medida estan pegadas por la X — asi que se
  // multiplica. Es el formato del papel higienico, que el art. 11 n°5 obliga a
  // informar por metro, y sin esta regla quedaban todos sin PPUM.
  const nxm = texto.match(/(\d+)\s*X\s*(\d+(?:[.,]\d+)?)\s*(KGS?|GRS?|G|MG|LTS?|L|ML|CC|MTS?|M|CM)(?![A-Z])/);
  if (nxm) {
    const piezas = Number(nxm[1]);
    const porPieza = Number(String(nxm[2]).replace(",", "."));
    const unit = unidadCanonica(nxm[3]);
    if (piezas > 0 && porPieza > 0 && unit) {
      return { value: piezas * porPieza, unit, origen: `${piezas} x ${porPieza} ${unit}` };
    }
  }

  const encontrados = [];
  for (const m of texto.matchAll(MEDIDA)) {
    const value = Number(String(m[1]).replace(",", "."));
    const unit = unidadCanonica(m[2]);
    if (value > 0 && unit) encontrados.push({ value, unit });
  }

  if (encontrados.length) {
    if (encontrados.some((e) => ES_MASA_O_VOLUMEN(e.unit)) && encontrados.some((e) => ES_CONTEO(e.unit))) {
      return { ambiguo: true };
    }
    encontrados.sort((a, b) => (PRIORIDAD[b.unit] || 0) - (PRIORIDAD[a.unit] || 0));
    return { ...encontrados[0], origen: "medida en el nombre" };
  }

  // Frutas y verduras usan otra convención: "Tomate Mediano (kg)",
  // "Lechuga Costina (c/u)", "Cebollín (Paquete)". El precio ya está expresado
  // en ese formato, así que el contenido es 1 de esa unidad (art. 5° para el
  // granel por kilo: el precio de venta ES el precio por unidad de medida).
  const parentesis = texto.match(/\((KGS?|KILOS?|K|LTS?|L|C\/U|CU|UNIDAD(?:ES)?|UN|PAQUETE|ATADO|BANDEJA)[^)]*\)/i);
  if (parentesis) {
    const forma = parentesis[1].toUpperCase();
    const unit = forma.startsWith("K") ? "kg" : forma.startsWith("L") ? "L" : "un";
    return { value: 1, unit, origen: `formato "(${forma})"` };
  }

  const suelto = texto.match(FORMATO_SUELTO);
  if (suelto) {
    const letra = suelto[1].toUpperCase();
    const unit = letra.startsWith("K") ? "kg" : letra.startsWith("U") ? "un" : "L";
    return { value: 1, unit, origen: `formato "${letra}"` };
  }

  return null;
};

/** Precio del tramo de unidad, para el catálogo heredado que no tiene `price`. */
const precioDeTramos = (producto) => {
  const tiers = producto?.pricing?.tiers;
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  const unidad = [...tiers].sort((a, b) => (a.min_qty || 1) - (b.min_qty || 1))[0];
  return Number(unidad?.price || 0);
};

// ── Ejecución ────────────────────────────────────────────────────────────────
// Solo corre cuando se invoca como script. Así los tests pueden importar el
// parser sin abrir una conexión a Mongo.
const invocadoDirecto = String(process.argv[1] || "").split("\\").join("/").endsWith("scripts/backfillPpum.js");
if (!invocadoDirecto) {
  // eslint-disable-next-line no-undef
} else {

await mongoose.connect(MONGO_URI);
console.log(`✅  Conectado${aplicar ? "" : "  (simulación: no se escribe nada)"}`);

const products = mongoose.connection.db.collection("products");
const todos = await products.find({}).toArray();

const operaciones = [];
const rellenados = [];
const yaTenian = [];
const sinDatos = [];
const ambiguos = [];
const cajas = [];

for (const producto of todos) {
  if (producto.product_type === "box") {
    cajas.push(producto.name);
    continue;
  }

  const tieneContenido =
    Number(producto.unit_content?.value) > 0 && String(producto.unit_content?.unit || "").trim();

  const leido = tieneContenido ? null : contenidoDesdeNombre(producto.name);

  if (leido?.ambiguo) {
    ambiguos.push(producto.name);
    continue;
  }

  const unitContent = tieneContenido
    ? producto.unit_content
    : leido
      ? { value: leido.value, unit: leido.unit }
      : null;

  if (!unitContent) {
    sinDatos.push(producto.name);
    continue;
  }

  // El catálogo heredado no tiene `price`: el precio vive en el tramo de unidad
  // de `pricing.tiers`. Es la misma regla de compatibilidad que ya aplica el
  // pre-save del modelo, así que se aprovecha para dejar el campo normalizado.
  const precio = Number(producto.price) > 0 ? Number(producto.price) : precioDeTramos(producto);
  if (!(precio > 0)) {
    sinDatos.push(producto.name);
    continue;
  }

  const ppum = ppumDeProducto({ ...producto, price: precio, unit_content: unitContent });
  if (!ppum) {
    sinDatos.push(producto.name);
    continue;
  }

  const set = {
    price: precio,
    "unit_content.value": unitContent.value,
    "unit_content.unit": unitContent.unit,
    "ppum.mode": producto.ppum?.mode || "auto",
    "ppum.value": ppum.valor,
    "ppum.unit_label": ppum.etiqueta,
    "ppum.text": ppum.texto,
  };
  operaciones.push({ updateOne: { filter: { _id: producto._id }, update: { $set: set } } });

  const fila = { nombre: producto.name, precio, ppum: ppum.texto, origen: leido?.origen || "ya cargado" };
  (tieneContenido ? yaTenian : rellenados).push(fila);
}

if (aplicar && operaciones.length) {
  const res = await products.bulkWrite(operaciones, { ordered: false });
  console.log(`✍️   Escritos ${res.modifiedCount} productos`);
}

const conPpum = rellenados.length + yaTenian.length;
console.log("");
console.log(`Productos totales      : ${todos.length}`);
console.log(`Con PPUM               : ${conPpum}  (${((conPpum / todos.length) * 100).toFixed(1)}%)`);
console.log(`  ├─ leídos del nombre : ${rellenados.length}`);
console.log(`  └─ ya tenían datos   : ${yaTenian.length}`);
console.log(`Cajas Cibox (exentas)  : ${cajas.length}   — art. 8° n°1`);
console.log(`Sin datos suficientes  : ${sinDatos.length}`);
console.log(`Ambiguos (medida+conteo): ${ambiguos.length}`);

if (detalle && rellenados.length) console.table(rellenados.slice(0, 60));

if (ambiguos.length) {
  console.log(`
⚠️   Ambiguos — el nombre trae medida Y conteo, hay que decidir a mano si el`);
  console.log(`    peso es del envase completo o de cada pieza:`);
  ambiguos.forEach((n) => console.log(`   · ${n}`));
}

if (sinDatos.length) {
  console.log(`\n⚠️   Quedan sin PPUM (cargar contenido a mano en el panel):`);
  sinDatos.slice(0, 40).forEach((n) => console.log(`   · ${n}`));
  if (sinDatos.length > 40) console.log(`   … y ${sinDatos.length - 40} más`);
}

if (!aplicar) console.log("\nℹ️   Simulación. Corre con --aplicar para escribir.");

await mongoose.disconnect();
}
