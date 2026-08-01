// ─────────────────────────────────────────────────────────────────────────────
// SEED MAESTRO DE DEMO — deja la base con un dataset sintético COHERENTE para que
// la directiva recorra TODO el sistema con datos que "conversan entre sí":
//   • catálogo (sectores, categorías, productos)         [solo si faltan]
//   • usuarios de staff por rol (para iniciar sesión)     [password demo conocida]
//   • clientes con crédito + sus facturas/deudas ligadas  → pantalla Clientes
//   • pedidos del relay en todas las etapas + kardex       → Reportes/Gerencia/Picking
//   • autorizaciones de precio/anulación (pendientes + histórico) → Autorizaciones
//   • cobranza (deudas + cheques) para Finanzas
//
// BORRA la capa transaccional/demo antes de sembrar (idempotente y reproducible).
// NO borra el catálogo si ya existe (para no destruir un catálogo importado).
// Solo para entornos de DEMO/desarrollo. CLI:  node src/scripts/seedDemoAll.js
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

import { User } from "../models/User.js";
import Product from "../models/Product.js";
import Sector from "../models/Sector.js";
import Order from "../models/Order.js";
import StockMovement from "../models/StockMovement.js";
import Deuda from "../models/Deuda.js";
import Cheque from "../models/Cheque.js";
import Cliente from "../models/Cliente.js";
import Autorizacion from "../models/Autorizacion.js";
import AuditLog from "../models/AuditLog.js";
import CajaSession from "../models/CajaSession.js";
import { ROLES, BCRYPT_ROUNDS } from "../utils/constants.js";

import { seedCategories } from "../seed/seedCategories.js";
import { seedProducts } from "../seed/seedProducts.js";
import { seedDemoCobranza } from "./seedDemoCobranza.js";
import { seedRelayDemo } from "./seedRelayDemo.js";
import { seedDemoAutorizaciones } from "./seedDemoAutorizaciones.js";

const DEMO_PASSWORD = "Demo1234!"; // contraseña de DEMO conocida (reemplazar en prod)

const DEMO_USERS = [
  { email: "admin@demo.cl", name: "Admin Demo", role: ROLES.ADMIN },
  { email: "gerente@demo.cl", name: "Gerente Demo", role: ROLES.MANAGER },
  { email: "vendedor@demo.cl", name: "Vendedor Demo", role: ROLES.VENDEDOR },
  { email: "cajero@demo.cl", name: "Cajera Demo", role: ROLES.CASHIER },
  { email: "bodeguero@demo.cl", name: "Bodeguero Demo", role: ROLES.OPERATOR },
  { email: "pantalla@demo.cl", name: "Pantalla Demo", role: ROLES.PANTALLA },
];

const SECTORES = [
  { nombre: "Lácteos y refrigerados", orden: 1 },
  { nombre: "Abarrotes", orden: 2 },
  { nombre: "Bebidas y licores", orden: 3 },
  { nombre: "Limpieza y aseo", orden: 4 },
  { nombre: "Snacks y confites", orden: 5 },
];

const wipeOptional = async (path, label) => {
  try {
    const mod = await import(path);
    const Model = mod.default || Object.values(mod).find((v) => v?.deleteMany);
    if (Model?.deleteMany) { await Model.deleteMany({}); return label; }
  } catch { /* modelo ausente: se ignora */ }
  return null;
};

export async function seedDemoAll() {
  const log = (...a) => console.log(...a);

  // 1) WIPE de la capa transaccional/demo (deja el catálogo intacto).
  log("🧹 Borrando datos previos (pedidos, clientes, deudas, autorizaciones)…");
  await Promise.all([
    Order.deleteMany({}),
    StockMovement.deleteMany({}),
    Deuda.deleteMany({}),
    Cheque.deleteMany({}),
    Cliente.deleteMany({}),
    Autorizacion.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);
  const extras = (await Promise.all([
    wipeOptional("../models/CajaSession.js", "CajaSession"),
    wipeOptional("../models/Turno.js", "Turno"),
    wipeOptional("../models/TaxDocument.js", "TaxDocument"),
  ])).filter(Boolean);
  if (extras.length) log(`   · también limpiadas: ${extras.join(", ")}`);

  // 2) Catálogo: sembrar SOLO si falta (no destruye un catálogo ya importado).
  if ((await Sector.estimatedDocumentCount()) === 0) {
    await Sector.insertMany(SECTORES);
    log("📦 Sectores sembrados.");
  }
  if ((await Product.estimatedDocumentCount()) === 0) {
    log("📦 Catálogo vacío → sembrando categorías y productos demo…");
    try { await seedCategories(); } catch (e) { log("   (categorías:", e.message, ")"); }
    try { await seedProducts(); } catch (e) { log("   (productos:", e.message, ")"); }
    // Asigna sector a los productos recién creados que no lo tengan.
    const REGLAS = [
      [/leche|yogur|queso|mantequilla|margarina|crema|huevo|refriger/i, "Lácteos y refrigerados"],
      [/bebida|jugo|agua|cerveza|vino|gaseosa|n[eé]ctar|energ|pisco|ron/i, "Bebidas y licores"],
      [/detergente|cloro|jab[oó]n|lavaloza|papel|toalla|shampoo|aseo|limpia|desinfect/i, "Limpieza y aseo"],
      [/galleta|papas|snack|chocolate|dulce|caramelo|ramita|suflito|confite|man[ií]/i, "Snacks y confites"],
    ];
    const clasificar = (n = "") => { for (const [re, s] of REGLAS) if (re.test(n)) return s; return "Abarrotes"; };
    for (const p of await Product.find({}).select("_id name location").lean()) {
      if (!p.location?.sector) await Product.updateOne({ _id: p._id }, { $set: { "location.sector": clasificar(p.name) } });
    }
  }

  // 3) Usuarios de staff (para iniciar sesión). Password de DEMO conocida.
  const hash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  for (const u of DEMO_USERS) {
    await User.updateOne(
      { email: u.email },
      { $set: { name: u.name, role: u.role, email_verified: true, is_active: true, password_hash: hash } },
      { upsert: true },
    );
  }
  log(`👥 ${DEMO_USERS.length} usuarios de staff (password demo: ${DEMO_PASSWORD}).`);

  // 3b) Pickers (bodegueros) con NIVEL y PIN del tótem, para la pantalla "Pickers y
  //     niveles" y el tótem (/totem). Nombres iguales a los del relay para coherencia.
  const PICKERS = [
    { email: "luis@demo.cl", name: "Bodeguero Luis", nivel: "experto", pin: "1111" },
    { email: "caro@demo.cl", name: "Bodeguera Caro", nivel: "nuevo", pin: "2222" },
    { email: "tomas@demo.cl", name: "Bodeguero Tomás", nivel: "experto", pin: "3333" },
  ];
  for (const p of PICKERS) {
    await User.updateOne(
      { email: p.email },
      { $set: { name: p.name, role: ROLES.OPERATOR, email_verified: true, is_active: true, password_hash: hash, picker_nivel: p.nivel, picker_pin: p.pin } },
      { upsert: true },
    );
  }
  // El bodeguero demo principal también con PIN/nivel.
  await User.updateOne({ email: "bodeguero@demo.cl" }, { $set: { picker_nivel: "experto", picker_pin: "1234" } });
  log(`🎖️  ${PICKERS.length + 1} pickers con nivel + PIN del tótem (PINs demo: 1234/1111/2222/3333).`);

  // 4) Clientes con crédito + facturas/deudas ligadas + cheques.
  const cob = await seedDemoCobranza();
  log(`🤝 ${cob.clientes} clientes + ${cob.deudas} deudas ligadas + ${cob.cheques} cheques.`);

  // 5) Pedidos del relay (histórico + en curso) + kardex. Cobranza ya hecha (paso 4).
  const relay = await seedRelayDemo({ cobranza: false });
  log(`📈 ${relay.creados} pedidos (${relay.historicos} históricos + ${relay.enCurso} en curso) + costos/vencimientos + kardex.`);

  // 6) Autorizaciones (pendientes + histórico) ligadas a pedidos reales.
  const autz = await seedDemoAutorizaciones();
  log(`🛡️  ${autz.creados} autorizaciones (anulación + excepción de precio).`);

  // 7) Caja del día ABIERTA (para la Cajera) + bitácora de acciones sensibles, para
  //    que "Caja" y "Bitácora" no aparezcan vacías en la demo.
  const cajera = await User.findOne({ email: "cajero@demo.cl" }).select("_id name").lean();
  const auditor = (await User.findOne({ email: "gerente@demo.cl" }).select("_id name role").lean())
    || (await User.findOne({ email: "admin@demo.cl" }).select("_id name role").lean());
  if (cajera) {
    const hoy830 = new Date(); hoy830.setHours(8, 30, 0, 0);
    const ventasEfe = 128400;
    await CajaSession.create({
      cajera_id: cajera._id, cajera_label: cajera.name, monto_inicial: 50000,
      ventas_efectivo: ventasEfe, monto_esperado: 50000 + ventasEfe, estado: "abierta", created_at: hoy830,
    });
  }
  if (auditor) {
    const dLog = (d) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(10 + (d % 8), 15, 0, 0); return x; };
    const A = { user_id: auditor._id, role: auditor.role, label: auditor.name };
    await AuditLog.insertMany([
      { action: "precio.cambio", actor: A, target: "Arroz Grado 1 · 1kg", detail: "Precio caja $18.900 → $17.500 (ajuste competencia)", at: dLog(0) },
      { action: "producto.editar", actor: A, target: "Aceite Vegetal 900cc", detail: "Stock mínimo 12 → 20 cajas", at: dLog(0) },
      { action: "usuario.rol", actor: A, target: "vendedor@demo.cl", detail: "Rol Vendedor asignado", at: dLog(1) },
      { action: "credito.override", actor: A, target: "Minimarket La Esquina", detail: "Venta a crédito autorizada sobre el cupo ($120.000)", at: dLog(1) },
      { action: "producto.editar", actor: A, target: "Detergente 3kg", detail: "Costo de compra actualizado", at: dLog(2) },
      { action: "precio.cambio", actor: A, target: "Bebida Cola 3L", detail: "Precio caja $9.600 → $8.900", at: dLog(3) },
      { action: "usuario.estado", actor: A, target: "cajero@demo.cl", detail: "Cuenta activada", at: dLog(4) },
      { action: "orden.anular", actor: A, target: "Pedido #A1B2C3", detail: "Anulación autorizada (cliente se arrepintió)", at: dLog(5) },
    ]);
  }
  log("💵 Caja del día abierta + 🧾 bitácora sembrada.");

  // 8) ACTIVIDAD EN VIVO (/admin/actividad): el relay siembra status_history con
  //    changed_by = {label, role} SIN user_id, y getActividad cuenta acciones por
  //    changed_by.user_id → la pantalla salía con "acciones_hoy: 0". Aquí se
  //    atribuye user_id (usuario demo según rol) a las entradas de HOY y se marca
  //    last_seen reciente escalonado para que el tablero se vea con vida.
  //    Idempotente: re-escribir user_id/last_seen con los mismos valores es inocuo.
  {
    const emails = ["vendedor@demo.cl", "cajero@demo.cl", "bodeguero@demo.cl", "gerente@demo.cl"];
    const demoUsers = await User.find({ email: mongoose.trusted({ $in: emails }) }).select("_id email name").lean();
    const byEmail = Object.fromEntries(demoUsers.map((u) => [u.email, u]));
    const ROL_A_USUARIO = {
      vendedor: byEmail["vendedor@demo.cl"],
      cashier: byEmail["cajero@demo.cl"],
      operator: byEmail["bodeguero@demo.cl"],
    };

    // 8a) Presencia: last_seen reciente escalonado (3 conectados + 1 visto hace poco).
    const now = Date.now();
    const PRESENCIA = [
      ["vendedor@demo.cl", 45 * 1000],       // conectado (hace <1 min)
      ["cajero@demo.cl", 90 * 1000],         // conectado (hace ~1,5 min)
      ["bodeguero@demo.cl", 150 * 1000],     // conectado (hace ~2,5 min)
      ["gerente@demo.cl", 6 * 60 * 1000],    // visto hace 6 min (fuera de línea)
    ];
    for (const [email, agoMs] of PRESENCIA) {
      const u = byEmail[email];
      if (u) await User.collection.updateOne({ _id: u._id }, { $set: { last_seen: new Date(now - agoMs) } });
    }

    // 8b) Atribución: user_id en las entradas de status_history de HOY según rol.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const pedidosHoy = await Order.find({ "status_history.changed_at": mongoose.trusted({ $gte: startOfDay }) })
      .select("status status_history assigned_to").lean();
    let atribuidas = 0;
    for (const o of pedidosHoy) {
      let dirty = false;
      const hist = (o.status_history || []).map((h) => {
        const demoU = h.changed_by?.role ? ROL_A_USUARIO[h.changed_by.role] : null;
        if (!demoU || new Date(h.changed_at) < startOfDay) return h;
        dirty = true;
        atribuidas++;
        // Solo agrega user_id (para Actividad, que cuenta por usuario). Conserva el
        // label original para no colapsar los miembros de Desempeño (agrupa por label).
        return { ...h, changed_by: { ...h.changed_by, user_id: demoU._id } };
      });
      const set = dirty ? { status_history: hist } : {};
      // El bodeguero demo aparece "ocupado" con su picking en curso.
      const bod = ROL_A_USUARIO.operator;
      if (o.status === "preparing" && bod && !o.assigned_to?.user_id) {
        set.assigned_to = { user_id: bod._id, label: bod.name, role: "operator" };
      }
      if (Object.keys(set).length) await Order.collection.updateOne({ _id: o._id }, { $set: set });
    }
    log(`📡 Actividad en vivo: ${atribuidas} acciones de hoy atribuidas a usuarios demo + presencia (last_seen) escalonada.`);
  }

  return {
    usuarios: DEMO_USERS.length,
    clientes: cob.clientes,
    deudas: cob.deudas,
    cheques: cob.cheques,
    pedidos: relay.creados,
    autorizaciones: autz.creados,
    password_demo: DEMO_PASSWORD,
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/seedDemoAll.js")) {
  dotenv.config();
  mongoose.connect(process.env.MONGO_URI)
    .then(() => seedDemoAll())
    .then((r) => {
      console.log("\n✅ DEMO LISTA — dataset coherente sembrado:");
      console.table(r);
      console.log("\n   Inicia sesión con  admin@demo.cl / " + r.password_demo + "  (o gerente@, cajero@, vendedor@, bodeguero@).");
      process.exit(0);
    })
    .catch((e) => { console.error("❌", e); process.exit(1); });
}
