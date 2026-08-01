/**
 * Seed Bodega 12 — Liquidadora y Supermercado Mayorista.
 *
 * Idempotente:
 *   - Categorías: upsert por slug.
 *   - Productos: upsert por sku.
 *   - NO toca users / orders / vendors.
 *   - Elimina los 3 productos demo (ABA-*).
 *
 * Uso: node scripts/seedBodega12.js
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

import { Category } from "../src/models/Category.js";
import { Product } from "../src/models/Product.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/bodega12";

const VENDOR = { id: "6a2ca4c933d4b4431ba9fbd0", name: "Bodega 12" };
const DEMO_SKUS = ["ABA-ARR-001", "ABA-ACE-001", "ABA-AZU-001"];

/* ------------------------------ helpers ---------------------------------- */

// slugify simple: minúsculas, sin tildes, guiones.
const slugify = (str) =>
  String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const normalizeText = (str) =>
  String(str ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

// EAN13 ficticio: "780" + 10 dígitos derivados del índice.
const fakeEan13 = (index) => {
  const seq = String(100000000 + index * 7919).slice(0, 10);
  return `780${seq}`;
};

// Las 11 categorías del catálogo.
const CATEGORIES = [
  "Abarrotes",
  "Lácteos",
  "Bebidas",
  "Galletas y Confites",
  "Snacks",
  "Conservas",
  "Aseo y Limpieza",
  "Papeles",
  "Cecinas",
  "Congelados",
  "Desayuno y Dulces",
];

// Catálogo: name|brand|category|unit_price|case_qty|case_unit_price|sku
const CATALOG_RAW = `
Aceite vegetal 900ml|Los Silos|Abarrotes|1449|12|1290|B12-R01
Mantequilla 200g|Tonadita|Lácteos|1350|24|1190|B12-R02
Salsa de tomate 200g|Traverso|Abarrotes|230|48|199|B12-R03
Not Chori pack 4|NotCo|Cecinas|1590|10|1390|B12-R04
Papas prefritas 2,25kg|McCain|Congelados|3890|8|3490|B12-R05
Spaghetti 400g|Parma|Abarrotes|579|20|499|B12-R06
Marshmallow|Capibara|Galletas y Confites|570|12|490|B12-R07
Yogurt batido 115g|Soprole|Lácteos|180|12|155|B12-R08
Crema de leche 250ml|Nestlé|Lácteos|850|24|750|B12-R09
Spaghetti N5 400g|Lucchetti|Abarrotes|890|20|790|B12-001
Tallarín 87 400g|Carozzi|Abarrotes|950|20|850|B12-002
Arroz grado 1 1kg|Tucapel|Abarrotes|1490|10|1350|B12-003
Arroz grado 2 1kg|Miraflores|Abarrotes|1190|10|1090|B12-004
Harina sin polvos 1kg|Selecta|Abarrotes|1090|10|990|B12-005
Azúcar granulada 1kg|Iansa|Abarrotes|1150|10|1050|B12-006
Aceite maravilla 1L|Chef|Abarrotes|2290|12|2090|B12-007
Atún lomitos en agua 160g|San José|Conservas|1190|24|1050|B12-008
Jurel al natural 425g|Colorado|Conservas|1590|24|1450|B12-009
Salsa de tomate 200g|Pomarola|Abarrotes|350|48|310|B12-010
Lentejas 1kg|Banquete|Abarrotes|1890|10|1750|B12-011
Puré de papas 125g|Maggi|Abarrotes|990|24|890|B12-012
Caldo de gallina 8 cubos|Maggi|Abarrotes|750|24|670|B12-013
Café instantáneo 170g|Monterrey|Desayuno y Dulces|2990|12|2750|B12-014
Té ceylan 100 bolsitas|Supremo|Desayuno y Dulces|2490|12|2290|B12-015
Cola Cao 800g|Idilia|Desayuno y Dulces|4290|6|3990|B12-016
Leche entera 1L|Soprole|Lácteos|1090|12|990|B12-017
Leche entera 1L|Colun|Lácteos|1150|12|1050|B12-018
Queso gauda laminado 500g|Colun|Lácteos|4990|10|4590|B12-019
Margarina 250g|Doña Juanita|Lácteos|890|24|790|B12-020
Leche condensada 397g|Nestlé|Lácteos|1690|24|1550|B12-021
Bebida Coca-Cola 3L|Coca-Cola|Bebidas|2590|4|2390|B12-022
Bebida Pepsi 3L|Pepsi|Bebidas|1990|4|1790|B12-023
Bilz 1,5L|CCU|Bebidas|1290|6|1150|B12-024
Néctar durazno 1L|Watt's|Bebidas|990|12|890|B12-025
Agua mineral 1,6L|Cachantun|Bebidas|890|6|790|B12-026
Jugo en polvo 20g|Zuko|Bebidas|190|96|159|B12-027
Galleta Frac 135g|McKay|Galletas y Confites|690|30|590|B12-028
Galleta Tritón 126g|McKay|Galletas y Confites|690|30|590|B12-029
Galleta de soda 195g|Costa|Galletas y Confites|590|24|520|B12-030
Chocolate Sahne-Nuss 80g|Nestlé|Galletas y Confites|1890|20|1690|B12-031
Súper 8|Costa|Galletas y Confites|240|20|199|B12-032
Trencito 150g|Nestlé|Galletas y Confites|2190|16|1990|B12-033
Papas fritas 185g|Marco Polo|Snacks|1590|15|1390|B12-034
Ramitas saladas 250g|Evercrisp|Snacks|1490|12|1290|B12-035
Detergente polvo 800g|Omo|Aseo y Limpieza|2990|12|2690|B12-036
Detergente líquido 3L|Drive|Aseo y Limpieza|5990|4|5490|B12-037
Lavalozas 750ml|Quix|Aseo y Limpieza|1290|12|1150|B12-038
Cloro gel 900ml|Clorox|Aseo y Limpieza|1190|12|1050|B12-039
Papel higiénico pack 4|Elite|Papeles|1590|12|1390|B12-040
Toalla de papel pack 2|Nova|Papeles|1890|12|1690|B12-041
Servilletas 100 un|Elite|Papeles|590|24|520|B12-042
Vienesas tradicionales 1kg|PF|Cecinas|2990|10|2690|B12-043
Jamón sandwich 250g|San Jorge|Cecinas|1690|20|1490|B12-044
Hamburguesas 10 un|PF|Congelados|4490|8|3990|B12-045
`.trim();

// Categorías donde el segundo tier conviene rotularse "Pack N" en vez de "Caja N".
const PACK_CATEGORIES = new Set(["Bebidas", "Lácteos"]);

const parseCatalog = () =>
  CATALOG_RAW.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, brand, category, unit_price, case_qty, case_unit_price, sku] =
        line.split("|");
      return {
        name: name.trim(),
        brand: brand.trim(),
        category: category.trim(),
        unit_price: Number(unit_price),
        case_qty: Number(case_qty),
        case_unit_price: Number(case_unit_price),
        sku: sku.trim(),
      };
    });

const buildDescription = (name, brand, categoryName) =>
  `${name} marca ${brand}. Disponible por unidad o por caja a precio mayorista para retiro en Bodega 12 (${categoryName}).`;

const caseLabel = (categoryName, caseQty) => {
  // Para packs pequeños de bebidas/lácteos, "Pack N" calza mejor.
  if (PACK_CATEGORIES.has(categoryName) && caseQty <= 12) {
    return `Pack ${caseQty} un`;
  }
  return `Caja ${caseQty} un`;
};

/* ----------------------------- seed flow --------------------------------- */

const seedCategories = async () => {
  const map = new Map(); // name -> { id, name, slug }
  let i = 0;
  for (const name of CATEGORIES) {
    const slug = slugify(name);
    const cat = await Category.findOneAndUpdate(
      { slug },
      {
        $set: {
          name,
          slug,
          is_active: true,
          sort_order: i,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    map.set(name, { id: String(cat._id), name: cat.name, slug });
    i += 1;
  }
  return map;
};

const seedProducts = async (categoryMap) => {
  const items = parseCatalog();
  let ok = 0;
  const errors = [];

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const cat = categoryMap.get(it.category);
    if (!cat) {
      errors.push(`Categoría inexistente para ${it.sku}: ${it.category}`);
      continue;
    }

    const tiers = [
      { min_qty: 1, price: it.unit_price, label: "Unidad" },
      {
        min_qty: it.case_qty,
        price: it.case_unit_price,
        label: caseLabel(it.category, it.case_qty),
      },
    ];

    const categoryObj = { id: cat.id, name: cat.name };

    const payload = {
      vendor: VENDOR,
      product_type: "simple",
      name: it.name,
      images: [],
      thumbnail: "",
      search_name: normalizeText(it.name),
      description: buildDescription(it.name, it.brand, it.category),
      category: categoryObj,
      categories: [categoryObj],
      category_ids: [cat.id],
      pricing: { tiers },
      box_items: [],
      stock: it.case_qty * 10,
      is_active: true,
      cibox_plus: { enabled: false },
      sku: it.sku,
      brand: it.brand,
      barcode: fakeEan13(idx + 1),
    };

    try {
      // Usamos find + save (no findOneAndUpdate) para que corra el hook
      // pre('save') que calcula pricing.min_price y search_name, evitando el
      // conflicto de paths entre `pricing` (objeto) y `pricing.min_price`.
      let doc = await Product.findOne({ sku: it.sku });
      if (!doc) doc = new Product();
      Object.assign(doc, payload);
      await doc.save();
      ok += 1;
    } catch (err) {
      errors.push(`${it.sku}: ${err.message}`);
    }
  }

  return { ok, errors, total: items.length };
};

const run = async () => {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`[seed] conectado a ${MONGO_URI.replace(/\/\/.*@/, "//***@")}`);

  // Eliminar productos demo
  const del = await Product.deleteMany({ sku: { $in: DEMO_SKUS } });
  console.log(`[seed] productos demo eliminados: ${del.deletedCount}`);

  const categoryMap = await seedCategories();
  console.log(`[seed] categorías upsert: ${categoryMap.size}`);

  const { ok, errors, total } = await seedProducts(categoryMap);
  console.log(`[seed] productos upsert: ${ok}/${total}`);
  if (errors.length) {
    console.error(`[seed] errores (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
  }

  const productCount = await Product.countDocuments({ "vendor.id": VENDOR.id });
  const categoryCount = await Category.countDocuments({});
  console.log(
    `[seed] totales BD -> productos vendor: ${productCount}, categorías: ${categoryCount}`,
  );

  await mongoose.disconnect();
  console.log("[seed] listo");
  process.exit(errors.length ? 1 : 0);
};

run().catch(async (err) => {
  console.error("[seed] fallo:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* noop */
  }
  process.exit(1);
});
