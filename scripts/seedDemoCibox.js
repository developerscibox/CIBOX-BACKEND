/**
 * Semilla de DEMOSTRACIÓN de Cibox.
 *
 * Deja el sistema listo para verlo funcionando en local: usuarios del equipo,
 * árbol de categorías con subcategorías, un catálogo de supermercado que usa
 * los campos de la Fase 3 (SKU, unidad de venta, contenido, IVA, pack) y unos
 * pedidos repartidos por la máquina de estados de la Fase 5.
 *
 * Es RE-EJECUTABLE: limpia lo que sembró antes (lo reconoce por el patrón de
 * SKU y por el cliente demo) y lo rehace. No toca nada que no haya creado él.
 *
 * Uso:  node scripts/seedDemoCibox.js
 *       SEED_PASSWORD="OtraClave1!" node scripts/seedDemoCibox.js
 *
 * ⚠️ Solo para desarrollo. La contraseña de las cuentas demo se pasa por
 * variable de entorno; nunca hay credenciales escritas en el código.
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { connectDB } from "../src/config/db.js";
import { brand } from "../src/config/brand.js";
import { User } from "../src/models/User.js";
import Vendor from "../src/models/Vendor.js";
import { Category } from "../src/models/Category.js";
import Product from "../src/models/Product.js";
import Order from "../src/models/Order.js";
import StockMovement from "../src/models/StockMovement.js";
import { MOVEMENT_TYPES, ORDER_STATUS, BCRYPT_ROUNDS } from "../src/utils/constants.js";
import { normalizeText } from "../src/utils/text.js";

const PASSWORD = process.env.SEED_PASSWORD || "Cibox2026!";
const SKU_DEMO = /^CIB-1\d{3}$/; // los SKU que genera este seeder

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ── Equipo ───────────────────────────────────────────────────────────────────
const USUARIOS = [
  { name: "Gabriel Farías", email: "admin@cibox.cl", role: "admin" },
  { name: "Gerencia Cibox", email: "gerente@cibox.cl", role: "manager" },
  { name: "Operaciones Cibox", email: "operaciones@cibox.cl", role: "operator" },
  { name: "Cliente de prueba", email: "cliente@cibox.cl", role: "customer" },
];

// ── Catálogo: categoría → subcategorías ─────────────────────────────────────
const ARBOL = {
  Despensa: ["Aceites", "Arroz y pastas", "Conservas", "Azúcar y endulzantes"],
  "Bebidas y jugos": ["Bebidas", "Aguas", "Jugos"],
  "Lácteos y huevos": ["Leches", "Quesos", "Yoghurt", "Huevos"],
  "Limpieza del hogar": ["Detergentes", "Lavaloza", "Papel"],
  "Cuidado personal": ["Higiene bucal", "Shampoo", "Jabones"],
  Snacks: ["Galletas", "Papas fritas", "Chocolates"],
};

// price = precio de venta CON IVA. pack = [unidades, precio del pack].
const CATALOGO = [
  // producto,                          marca,        cat,                 subcat,           unidad, contenido,     precio, costo, stock, pack
  ["Aceite vegetal 900 ml",             "Chef",       "Despensa",          "Aceites",        "unidad", [900, "ml"],  2190, 1490, 120, [6, 12490]],
  ["Aceite de oliva extra virgen 500 ml", "Olivar",   "Despensa",          "Aceites",        "unidad", [500, "ml"],  6990, 4800,  40, null],
  ["Arroz grado 1 · 1 kg",              "Miraflores", "Despensa",          "Arroz y pastas", "kg",     [1, "kg"],    1690, 1150, 200, [10, 15490]],
  ["Spaghetti N°5 400 g",               "Lucchetti",  "Despensa",          "Arroz y pastas", "unidad", [400, "g"],    990,  620, 180, null],
  ["Atún lomitos en agua 160 g",        "San José",   "Despensa",          "Conservas",      "unidad", [160, "g"],   1590, 1090,  95, [4, 5690]],
  ["Azúcar granulada 1 kg",             "Iansa",      "Despensa",          "Azúcar y endulzantes", "kg", [1, "kg"],  1290,  880, 140, null],
  ["Bebida cola 1,5 L",                 "Coca-Cola",  "Bebidas y jugos",   "Bebidas",        "unidad", [1.5, "L"],   2290, 1590,  90, [6, 12490]],
  ["Agua mineral sin gas 1,6 L",        "Vital",      "Bebidas y jugos",   "Aguas",          "unidad", [1.6, "L"],   1190,  740, 160, null],
  ["Néctar durazno 1 L",                "Watt's",     "Bebidas y jugos",   "Jugos",          "unidad", [1, "L"],     1490,  980,  70, null],
  ["Leche entera 1 L",                  "Colun",      "Lácteos y huevos",  "Leches",         "unidad", [1, "L"],    1190,  840, 210, [12, 12990]],
  ["Queso mantecoso 500 g",             "Colun",      "Lácteos y huevos",  "Quesos",         "unidad", [500, "g"],   6490, 4700,  35, null],
  ["Yoghurt natural 1 kg",              "Soprole",    "Lácteos y huevos",  "Yoghurt",        "unidad", [1, "kg"],    2790, 1950,  48, null],
  ["Huevos color grandes",              "Chacra",     "Lácteos y huevos",  "Huevos",         "bandeja", [12, "un"],  3490, 2400,  60, null],
  ["Detergente líquido 3 L",            "Omo",        "Limpieza del hogar", "Detergentes",   "unidad", [3, "L"],     8990, 6300,  25, null],
  ["Lavaloza limón 750 ml",             "Quix",       "Limpieza del hogar", "Lavaloza",      "unidad", [750, "ml"],  1890, 1290,  80, null],
  ["Papel higiénico 12 rollos",         "Elite",      "Limpieza del hogar", "Papel",         "pack",   [12, "un"],   7490, 5200,  55, null],
  ["Pasta dental 90 g",                 "Colgate",    "Cuidado personal",  "Higiene bucal",  "unidad", [90, "g"],    1790, 1180,  70, null],
  ["Shampoo anticaspa 400 ml",          "Head & Sh.", "Cuidado personal",  "Shampoo",        "unidad", [400, "ml"],  4990, 3400,  42, null],
  ["Jabón de tocador 3 un",             "Lux",        "Cuidado personal",  "Jabones",        "pack",   [3, "un"],    1690, 1090,  88, null],
  ["Galletas de vainilla 140 g",        "Tritón",     "Snacks",            "Galletas",       "unidad", [140, "g"],    890,  560, 130, [6, 4690]],
  ["Papas fritas 250 g",                "Lays",       "Snacks",            "Papas fritas",   "unidad", [250, "g"],   2690, 1850,  64, null],
  ["Chocolate leche 100 g",             "Sahne",      "Snacks",            "Chocolates",     "unidad", [100, "g"],   1590, 1050,  75, null],
  // Casos que se ven en las alertas de stock: quiebre y crítico.
  ["Sal de mar fina 1 kg",              "Lobos",      "Despensa",          "Azúcar y endulzantes", "kg", [1, "kg"],  1090,  700,   0, null],
  ["Vinagre de manzana 500 ml",         "Traverso",   "Despensa",          "Aceites",        "unidad", [500, "ml"],  1390,  920,   4, null],
];

const run = async () => {
  await connectDB();
  console.log(`\n🌱 Sembrando la demo de ${brand.name}…\n`);

  // ── 1. Limpieza de lo sembrado antes ──────────────────────────────────────
  // Se identifica por el patrón de SKU y por el cliente demo: nada de campos
  // extra en los modelos de producción solo para marcar la demo.
  const previos = await Product.find({ sku: SKU_DEMO }).select("_id").lean();
  const ids = previos.map((p) => p._id);
  const clienteDemo = await User.findOne({ email: "cliente@cibox.cl" }).select("_id").lean();
  if (clienteDemo) await Order.deleteMany({ user_id: clienteDemo._id });
  if (ids.length) {
    // sanitizeFilter global: los operadores en queries con datos externos van con trusted().
    await StockMovement.deleteMany({ product_id: mongoose.trusted({ $in: ids }) });
    await Product.deleteMany({ _id: mongoose.trusted({ $in: ids }) });
  }

  // ── 2. Equipo ─────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
  const usuarios = {};
  for (const u of USUARIOS) {
    const doc = await User.findOneAndUpdate(
      { email: u.email },
      { $set: { name: u.name, role: u.role, password_hash: hash, is_active: true, email_verified: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    usuarios[u.role] = doc;
  }
  console.log(`   ✓ ${USUARIOS.length} usuarios (contraseña: ${PASSWORD})`);

  // ── 3. Vendor de la plataforma (Product.vendor es obligatorio) ────────────
  const vendor = await Vendor.findOneAndUpdate(
    { user_id: usuarios.admin._id },
    { $set: { name: brand.name, is_active: true, status: "approved", commission_rate: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const vendorRef = { id: String(vendor._id), name: brand.name };

  // ── 4. Categorías y subcategorías ─────────────────────────────────────────
  const catPorNombre = {};
  let orden = 0;
  for (const [padre, hijas] of Object.entries(ARBOL)) {
    const p = await Category.findOneAndUpdate(
      { slug: slug(padre) },
      { $set: { name: padre, slug: slug(padre), parent_id: null, is_active: true, is_featured: true, sort_order: orden++ } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    catPorNombre[padre] = p;
    let sub = 0;
    for (const hija of hijas) {
      const h = await Category.findOneAndUpdate(
        { slug: slug(`${padre}-${hija}`) },
        { $set: { name: hija, slug: slug(`${padre}-${hija}`), parent_id: p._id, is_active: true, sort_order: sub++ } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      catPorNombre[`${padre}/${hija}`] = h;
    }
  }
  const nSub = Object.values(ARBOL).reduce((a, h) => a + h.length, 0);
  console.log(`   ✓ ${Object.keys(ARBOL).length} categorías con ${nSub} subcategorías`);

  // ── 5. Catálogo ───────────────────────────────────────────────────────────
  const creados = [];
  let sku = 1000;
  for (const [nombre, marca, cat, subcat, unidad, contenido, precio, costo, stock, pack] of CATALOGO) {
    const c = catPorNombre[cat];
    const sc = catPorNombre[`${cat}/${subcat}`];
    const p = await Product.create({
      vendor: vendorRef,
      sku: `CIB-${++sku}`,
      barcode: `78010000${String(sku).padStart(5, "0")}`,
      name: nombre,
      search_name: normalizeText(nombre),
      brand: marca,
      description: `${nombre} — ${marca}. ${contenido[0]} ${contenido[1]}.`,
      category: { id: String(c._id), name: c.name },
      subcategory: { id: String(sc._id), name: sc.name },
      categories: [{ id: String(c._id), name: c.name }, { id: String(sc._id), name: sc.name }],
      category_ids: [String(c._id), String(sc._id)],
      sale_unit: unidad,
      unit_content: { value: contenido[0], unit: contenido[1] },
      price: precio,
      pack_size: pack ? pack[0] : 0,
      pack_price: pack ? pack[1] : 0,
      tax: { afecto: true },
      cost_price: costo,
      stock,
      min_stock: Math.max(6, Math.round(stock * 0.15)),
      target_stock: Math.max(20, Math.round(stock * 0.5)),
      is_active: true,
      featured: creados.length < 8,
    });
    creados.push(p);

    // Kardex de la carga inicial: el stock nunca aparece de la nada.
    if (stock > 0) {
      await StockMovement.create({
        product_id: p._id,
        product_name: p.name,
        type: MOVEMENT_TYPES.RECEIVING,
        quantity: stock,
        stock_after: stock,
        reason: "Carga inicial del catálogo",
        by: { user_id: usuarios.admin._id, role: "admin", label: usuarios.admin.name },
      });
    }
  }
  console.log(`   ✓ ${creados.length} productos (2 con stock crítico/quiebre para ver las alertas)`);

  // ── 6. Merma de ejemplo, para que el kardex tenga los cuatro tipos ────────
  const conMerma = creados.find((p) => p.stock > 20);
  if (conMerma) {
    await Product.updateOne({ _id: conMerma._id }, { $inc: { stock: -3 } });
    await StockMovement.create({
      product_id: conMerma._id,
      product_name: conMerma.name,
      type: MOVEMENT_TYPES.MERMA,
      quantity: -3,
      stock_after: conMerma.stock - 3,
      reason: "3 unidades con envase roto en bodega",
      by: { user_id: usuarios.operator._id, role: "operator", label: usuarios.operator.name },
    });
  }

  // ── 7. Pedidos repartidos por la máquina de estados ──────────────────────
  const cliente = usuarios.customer;
  const ahora = Date.now();
  const historia = (estados, base) =>
    estados.map((s, i) => ({
      status: s.estado,
      changed_at: new Date(base + i * 22 * 60000),
      note: s.nota,
      changed_by: { user_id: s.por?._id || null, role: s.por?.role || null, label: s.por?.name || "cliente" },
    }));

  const PEDIDOS = [
    { estados: [ORDER_STATUS.PENDING], entrega: "delivery", horas: 1 },
    { estados: [ORDER_STATUS.PENDING, ORDER_STATUS.PAID], entrega: "delivery", horas: 3 },
    { estados: [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING], entrega: "delivery", horas: 5 },
    { estados: [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY], entrega: "delivery", horas: 8 },
    { estados: [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.SHIPPED], entrega: "delivery", horas: 26 },
    { estados: [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED], entrega: "delivery", horas: 50 },
    { estados: [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.DELIVERED], entrega: "pickup", horas: 74 },
  ];

  const actorDe = {
    [ORDER_STATUS.PENDING]: null,
    [ORDER_STATUS.PAID]: usuarios.manager,
    [ORDER_STATUS.PREPARING]: usuarios.operator,
    [ORDER_STATUS.READY]: usuarios.operator,
    [ORDER_STATUS.SHIPPED]: usuarios.operator,
    [ORDER_STATUS.DELIVERED]: usuarios.operator,
  };
  const NOTAS = {
    [ORDER_STATUS.PENDING]: "Pedido confirmado por el cliente",
    [ORDER_STATUS.PAID]: "Pago confirmado",
    [ORDER_STATUS.PREPARING]: "Preparación iniciada",
    [ORDER_STATUS.READY]: "Empacado: 2 bultos",
    [ORDER_STATUS.SHIPPED]: "Salió a reparto",
    [ORDER_STATUS.DELIVERED]: "Entregado al cliente",
  };

  let hechos = 0;
  for (const [i, def] of PEDIDOS.entries()) {
    const seleccion = creados.slice(i * 2, i * 2 + 3).filter((p) => p.stock > 0);
    if (!seleccion.length) continue;
    const items = seleccion.map((p) => {
      const qty = 1 + (i % 3);
      return {
        product_id: p._id,
        name: p.name,
        quantity: qty,
        price: p.price,
        subtotal: p.price * qty,
        product_type: "simple",
      };
    });
    const subtotal = items.reduce((a, it) => a + it.subtotal, 0);
    const base = ahora - def.horas * 3600000;
    const final = def.estados[def.estados.length - 1];
    const pagado = def.estados.includes(ORDER_STATUS.PAID);

    await Order.create({
      user_id: cliente._id,
      items,
      customer: { fullName: cliente.name, email: cliente.email, phone: "+56 9 1234 5678", rut: "11.111.111-1" },
      status: final,
      source: "cart",
      delivery_method: def.entrega,
      ...(def.entrega === "pickup"
        ? { pickup: { committed_date: new Date(base + 86400000), location: "" } }
        : {
            shipping: {
              region: "Región Metropolitana",
              city: "Ñuñoa",
              address: "Av. Irarrázaval 1234, depto 501",
              amount: 2990,
            },
          }),
      payment: {
        method: "transfer",
        status: pagado ? "approved" : "pending",
        amount: subtotal,
        platform: "web",
      },
      subtotal,
      shipping_amount: def.entrega === "pickup" ? 0 : 2990,
      discount_amount: 0,
      total: subtotal + (def.entrega === "pickup" ? 0 : 2990),
      ...(pagado ? { paid_at: new Date(base + 22 * 60000) } : {}),
      ...(final === ORDER_STATUS.DELIVERED ? { delivered_at: new Date(base + def.estados.length * 22 * 60000) } : {}),
      stock_committed: def.estados.includes(ORDER_STATUS.READY),
      status_history: historia(
        def.estados.map((e) => ({ estado: e, nota: NOTAS[e], por: actorDe[e] })),
        base,
      ),
    });
    hechos += 1;
  }
  console.log(`   ✓ ${hechos} pedidos, uno en cada etapa de la máquina de estados`);

  console.log(`\n✅ Demo lista.\n`);
  console.log(`   Panel     http://localhost:5180   ${USUARIOS[0].email} / ${PASSWORD}`);
  console.log(`   Tienda    http://localhost:8081   ${USUARIOS[3].email} / ${PASSWORD}`);
  console.log(`   API       http://localhost:3001/health\n`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌ Falló la siembra:", err);
  process.exit(1);
});
