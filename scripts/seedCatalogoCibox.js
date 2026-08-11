/**
 * Catálogo REAL de Cibox — los 25 productos levantados desde las fotos de los
 * envases (marca, formato, código de barras y descripción salen de la etiqueta).
 *
 * Las imágenes son las de `backend/seed-assets/productos/`, ya recortadas y
 * sobre fondo blanco, y se sirven por el estático `/catalogo` que monta
 * `app.js`. Van versionadas con el repo, no en `uploads/`.
 *
 * Los precios son los REALES de venta de Cibox (lista del 10-08-2026). Lo que
 * NO viene de esa lista es el costo de compra: va en 0 hasta que se cargue, así
 * que el margen del panel todavía no significa nada.
 *
 * Lo que no tiene precio en la lista entra INACTIVO: un producto en $0 en la
 * tienda es peor que un producto que no está.
 *
 * Es RE-EJECUTABLE: reconoce lo suyo por el prefijo de SKU y lo rehace.
 *
 * Uso:  node scripts/seedCatalogoCibox.js
 *       PUBLIC_BASE_URL=http://192.168.1.3:3001 node scripts/seedCatalogoCibox.js
 */
import mongoose from "mongoose";

import { connectDB } from "../src/config/db.js";
import { brand } from "../src/config/brand.js";
import { User } from "../src/models/User.js";
import Vendor from "../src/models/Vendor.js";
import { Category } from "../src/models/Category.js";
import Product from "../src/models/Product.js";
import StockMovement from "../src/models/StockMovement.js";
import { MOVEMENT_TYPES } from "../src/utils/constants.js";
import { normalizeText } from "../src/utils/text.js";
import { seedCategories } from "../src/seed/seedCategories.js";

// Base pública del backend: la tienda pide las fotos por URL absoluta, así que
// en la red local hay que apuntar a la IP del equipo, no a localhost.
const BASE = (process.env.PUBLIC_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const SKU_CATALOGO = /^CIB-C\d{3}$/;

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// nombre, marca, categoría, subcategoría, unidad, [contenido, unidad],
// precio, costo, stock, código de barras, archivo de la foto, descripción
const CATALOGO = [
  ["Pasta Speciale Penne Rigate Tricolore Coliseo 400 g", "Coliseo", "Despensa", "Arroces y pastas",
   "unidad", [400, "g"], 990, 0, 90, "7804608222672", "pasta-penne-tricolore-coliseo-400g",
   "Pasta de sémola de grano duro con tomate y espinaca. Formato penne rigate tricolor, ideal para ensaladas y salsas."],

  ["Pasta Speciale Farfalle Coliseo 400 g", "Coliseo", "Despensa", "Arroces y pastas",
   "unidad", [400, "g"], 900, 0, 85, "7804608220654", "pasta-farfalle-coliseo-400g",
   "Pasta de sémola de grano duro 100%, formato corbatita. Rinde 5 porciones de 80 g."],

  ["Pasta Speciale Spaghetti Coliseo 400 g", "Coliseo", "Despensa", "Arroces y pastas",
   "unidad", [400, "g"], 550, 0, 110, "7798031153705", "pasta-spaghetti-coliseo-400g",
   "Spaghetti de sémola de grano duro 100%. Cocción 10 minutos."],

  ["Spaghetti Nº5 Carozzi 400 g", "Carozzi", "Despensa", "Arroces y pastas",
   "unidad", [400, "g"], 990, 0, 140, "7802575004437", "spaghetti-carozzi-n5-400g",
   "Pasta vitaminizada Carozzi, corte Nº5. Buena fuente de proteínas: aporta 8,8 g por porción."],

  ["Arroz Largo Ancho Grado 1 Miraflores 1 kg", "Miraflores", "Despensa", "Arroces y pastas",
   "unidad", [1, "kg"], 1850, 0, 160, "7802615006551", "arroz-miraflores-largo-ancho-g1-1kg",
   "Arroz seleccionado de grano largo ancho, grado 1. Grano suelto y parejo para todo tipo de preparaciones."],

  ["Arroz Gran Selección Grado 2 Tucapel 900 g", "Tucapel", "Despensa", "Arroces y pastas",
   "unidad", [900, "g"], 1450, 0, 130, "7801420001935", "arroz-tucapel-gran-seleccion-g2-900g",
   "Arroz grano largo ancho grado 2, 80% grano entero. Naturalmente bajo en grasas."],

  ["Arroz Grado 2 Grano Largo Misol 1 kg", "Misol", "Despensa", "Arroces y pastas",
   "unidad", [1, "kg"], 900, 0, 120, "7804676740153", "arroz-misol-g2-1kg",
   "Arroz grado 2 de grano largo. Rinde 20 porciones de 50 g."],

  ["Lentejas 6 mm Misol 1 kg", "Misol", "Despensa", "Legumbres",
   "unidad", [1, "kg"], 2590, 0, 70, "7804676740559", "lentejas-misol-1kg",
   "Lentejas grado 2 de 6 mm. Fuente de proteína vegetal: 24,2 g por cada 100 g."],

  ["Garbanzos Misol 1 kg", "Misol", "Despensa", "Legumbres",
   "unidad", [1, "kg"], 2490, 0, 60, "7804676740566", "garbanzos-misol-1kg",
   "Garbanzos grado 2 sin piel. Aportan 17,9 g de proteína por cada 100 g. Rinden 17 porciones."],

  ["Porotos Blancos Misol 1 kg", "Misol", "Despensa", "Legumbres",
   "unidad", [1, "kg"], 2990, 0, 65, "7804676740573", "porotos-blancos-misol-1kg",
   "Porotos blancos grado 2. Aportan 17,9 g de proteína por cada 100 g."],

  ["Sal Fina Yodada Kul & Bulk 1 kg", "Kul & Bulk", "Despensa", "Condimentos y especias",
   "unidad", [1, "kg"], 400, 0, 200, "0765066740979", "sal-fina-kul-bulk-1kg",
   "Sal fina yodada en granitos para cocinar. Cloruro de sodio y yodato de potasio."],

  ["Azúcar Blanca Granulada DoraSol 900 g", "DoraSol", "Despensa", "Azúcar y endulzantes",
   "unidad", [900, "g"], 850, 0, 180, "7804608224430", "azucar-dorasol-900g",
   "Azúcar blanca granulada. Rinde 90 porciones de 10 g."],

  ["Salsa de Tomate Italiana San Remo 200 g", "San Remo", "Despensa", "Salsas, aderezos y snacks",
   "unidad", [200, "g"], 510, 0, 240, "7802575365026", "salsa-san-remo-italiana-200g",
   "Salsa de tomates a la italiana con ajo, cebolla y orégano. Sachet de 5 porciones."],

  ["Salsa de Tomates Italiana Pomarola 200 g", "Pomarola", "Despensa", "Salsas, aderezos y snacks",
   "unidad", [200, "g"], 670, 0, 220, "7802575353047", "salsa-pomarola-italiana-200g",
   "Salsa de tomates a la italiana hecha con al menos 3 tomates del Valle Central. Sachet de 5 porciones."],

  ["Salsa de Tomate Italiana Coliseo 200 g", "Coliseo", "Despensa", "Salsas, aderezos y snacks",
   "unidad", [200, "g"], 320, 0, 260, "7804608221644", "salsa-coliseo-italiana-200g",
   "Salsa de tomate a la italiana en doypack con tapa. Con cebolla, ajo y orégano. 10 porciones de 20 g."],

  ["Café Liofilizado Instantáneo Cruzeiro 170 g", "Cruzeiro", "Despensa", "Té y café",
   "unidad", [170, "g"], 8290, 0, 55, "7896019208468", "cafe-cruzeiro-liofilizado-170g",
   "Café soluble liofilizado 100% café, aroma y sabor intenso. Rinde 85 tazas. Libre de gluten."],

  ["Té Negro Ceylán Original Club 100 bolsitas", "Club", "Despensa", "Té y café",
   "unidad", [200, "g"], 2350, 0, 75, "7802420009464", "te-club-ceylan-100-bolsitas",
   "Té negro Ceylán en 100 bolsitas de 2 g. Combinación balanceada de hojas de té negro."],

  ["Leche Sin Lactosa Semidescremada Colun 1 L", "Colun", "Lácteos, Huevos", "Lácteos sin lactosa",
   "unidad", [1, "L"], 1300, 0, 150, "7802920009322", "leche-colun-sin-lactosa-1l",
   "Leche natural semidescremada sin lactosa, no reconstituida. UHT: no requiere refrigeración hasta abrir. Libre de gluten."],

  ["Néctar de Piña Watt's 1,5 L", "Watt's", "Licores, Bebidas y Aguas", "Jugos",
   "unidad", [1.5, "L"], 1800, 0, 95, "7801620011635", "nectar-watts-pina-1-5l",
   "Néctar de piña hecho con fruta natural, reducido en calorías y endulzado con stevia. Rinde 8 vasos."],

  ["Powerade Frozen Blast 850 ml", "Powerade", "Licores, Bebidas y Aguas", "Bebidas",
   "unidad", [850, "ml"], 0, 0, 120, "7802820678147", "powerade-frozen-blast-850ml",
   "Bebida isotónica para deportistas con electrolitos y vitaminas. Hidratación duradera."],

  ["Papel Higiénico Black Triple Hoja Swan 4 rollos", "Swan", "Cuidado personal", "",
   "unidad", [4, "rollos"], 3290, 0, 100, "7804653342035", "papel-higienico-swan-black-4un",
   "Papel higiénico triple hoja de mayor suavidad. 4 rollos de 40 metros cada uno."],

  ["Toalla de Papel Profesional Premium Swan 2 rollos", "Swan", "Limpieza", "Accesorios de limpieza",
   "unidad", [2, "rollos"], 2100, 0, 90, "7804653341960", "toalla-papel-swan-2un",
   "Toalla de papel doble hoja con tecnología NTT: más espesor y absorción. 2 rollos de 24 metros."],

  ["Cloro Gel Tradicional Limón Brillex 900 ml", "Brillex", "Limpieza", "Limpieza de baños",
   "unidad", [900, "ml"], 1190, 0, 80, "8010690012322", "cloro-gel-brillex-limon",
   "Limpiador clorado en gel aroma limón. Para baño, tina, lavamanos, WC, ducha, azulejos y cerámicas. Biodegradable."],

  ["Lavalozas Concentrado Bicarbonato + Vinagre Fuzol 700 ml", "Fuzol", "Limpieza", "Limpieza de cocina",
   "unidad", [700, "ml"], 1090, 0, 110, "7804920010490", "lavalozas-fuzol-700ml",
   "Lavalozas concentrado con bicarbonato y vinagre, 3x poder desengrasante. Aroma fresco cítrico, sin aroma a vinagre."],

  ["Rice Cakes Rellenas Dulce de Leche Deluxe 12 un", "Deluxe", "Chocolates y Galletas", "",
   "unidad", [336, "g"], 0, 0, 70, "7798301130153", "rice-cakes-deluxe-dulce-leche",
   "Galletas de arroz integral rellenas con dulce de leche y bañadas en repostería blanca. 12 unidades de 28 g. Sin gluten."],

  // ── Están en la lista de precios pero todavía no tienen foto ni envase
  //    fotografiado: entran al catálogo con su precio y sin imagen. Falta el
  //    código de barras, que hay que leer del envase.
  ["Jabón Líquido Humectante Suavelina 750 ml", "Suavelina", "Limpieza", "",
   "unidad", [750, "ml"], 1250, 0, 0, "", "",
   "Jabón líquido humectante para manos. Envase de 750 ml."],

  ["Tallarín Nº87 Carozzi 400 g", "Carozzi", "Despensa", "Arroces y pastas",
   "unidad", [400, "g"], 990, 0, 0, "", "",
   "Pasta Carozzi, corte tallarín Nº87."],

  ["Agua Mineral LIV 3 L", "LIV", "Licores, Bebidas y Aguas", "Aguas",
   "unidad", [3, "L"], 990, 0, 0, "", "",
   "Agua mineral en bidón de 3 litros."],
];

async function main() {
  await connectDB();
  console.log(`\n🌱 Catálogo de Cibox — ${CATALOGO.length} productos\n`);

  // ── 1. Categorías reales del proyecto ─────────────────────────────────────
  await seedCategories();
  const todas = await Category.find({}).lean();
  const porSlug = Object.fromEntries(todas.map((c) => [c.slug, c]));
  const buscar = (nombre, padre = null) => {
    const s = slug(nombre);
    const hit = todas.find(
      (c) => c.slug === s && (padre === null || String(c.parent_id) === String(padre._id)),
    );
    return hit || porSlug[s] || null;
  };

  // ── 2. Vendor de la plataforma (Product.vendor es obligatorio) ────────────
  const admin = await User.findOne({ role: "admin" }).sort({ created_at: 1 });
  if (!admin) {
    console.error("✗ No hay usuario admin. Corre antes: node scripts/seedDemoCibox.js");
    process.exit(1);
  }
  const vendor = await Vendor.findOneAndUpdate(
    { user_id: admin._id },
    { $set: { name: brand.name, is_active: true, status: "approved", commission_rate: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const vendorRef = { id: String(vendor._id), name: brand.name };

  // ── 3. Limpieza de la corrida anterior ────────────────────────────────────
  const previos = await Product.find({ sku: SKU_CATALOGO }).select("_id").lean();
  if (previos.length) {
    const ids = previos.map((p) => p._id);
    // sanitizeFilter está activado en db.js: los operadores van con trusted().
    await StockMovement.deleteMany({ product_id: mongoose.trusted({ $in: ids }) });
    await Product.deleteMany({ _id: mongoose.trusted({ $in: ids }) });
    console.log(`   ↺ ${previos.length} productos de la corrida anterior eliminados`);
  }

  // ── 4. Alta del catálogo ──────────────────────────────────────────────────
  let n = 0;
  let activos = 0;
  const sinCategoria = [];
  const sinPrecio = [];
  const sinFoto = [];
  for (const [nombre, marca, cat, subcat, unidad, contenido, precio, costo, stock, ean, foto, desc] of CATALOGO) {
    const c = buscar(cat);
    if (!c) { sinCategoria.push(`${nombre} → ${cat}`); continue; }
    const sc = subcat ? buscar(subcat, c) : null;

    const cats = [{ id: String(c._id), name: c.name }];
    const catIds = [String(c._id)];
    if (sc) { cats.push({ id: String(sc._id), name: sc.name }); catIds.push(String(sc._id)); }

    // Sin foto todavía: el producto entra igual, pero sin imagen inventada.
    const url = foto ? `${BASE}/catalogo/${foto}.jpg` : "";
    const p = await Product.create({
      vendor: vendorRef,
      sku: `CIB-C${String(++n).padStart(3, "0")}`,
      barcode: ean,
      name: nombre,
      search_name: normalizeText(nombre),
      brand: marca,
      description: desc,
      images: url ? [url] : [],
      thumbnail: url,
      category: { id: String(c._id), name: c.name },
      subcategory: sc ? { id: String(sc._id), name: sc.name } : { id: "", name: "" },
      categories: cats,
      category_ids: catIds,
      sale_unit: unidad,
      unit_content: { value: contenido[0], unit: contenido[1] },
      price: precio,
      tax: { afecto: true },
      cost_price: costo,
      stock,
      min_stock: Math.max(6, Math.round(stock * 0.15)),
      target_stock: Math.max(20, Math.round(stock * 0.5)),
      // Sin precio no sale a la venta: mostrar un producto en $0 es peor que no
      // mostrarlo. Queda cargado y se activa solo con ponerle precio.
      is_active: precio > 0,
      featured: precio > 0 && n <= 8,
    });
    if (precio > 0) activos++; else sinPrecio.push(nombre);
    if (!foto) sinFoto.push(nombre);

    // El stock nunca aparece de la nada: queda su movimiento en el kardex.
    if (stock > 0) {
      await StockMovement.create({
        product_id: p._id,
        product_name: p.name,
        type: MOVEMENT_TYPES.RECEIVING,
        quantity: stock,
        stock_after: stock,
        reason: "Carga inicial del catálogo Cibox",
        by: { user_id: admin._id, role: "admin", label: admin.name },
      });
    }
  }

  console.log(`   ✓ ${n} productos cargados · ${activos} a la venta`);
  if (sinCategoria.length) {
    console.log(`   ⚠ ${sinCategoria.length} sin categoría:`);
    sinCategoria.forEach((s) => console.log(`      · ${s}`));
  }
  if (sinPrecio.length) {
    console.log(`   ⚠ ${sinPrecio.length} sin precio → cargados INACTIVOS:`);
    sinPrecio.forEach((s) => console.log(`      · ${s}`));
  }
  if (sinFoto.length) {
    console.log(`   ⚠ ${sinFoto.length} sin foto ni código de barras:`);
    sinFoto.forEach((s) => console.log(`      · ${s}`));
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("✗", e);
  await mongoose.disconnect();
  process.exit(1);
});
