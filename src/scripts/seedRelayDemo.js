// Demo COMPLETA del negocio "como si lleváramos un tiempo operando", para que cada
// parte del Centro de mando se vea con vida: ventas históricas (tendencia, por hora,
// vs periodo anterior), equipo, productos (top/menos/margen/quiebres), operación
// (tiempos/cuello/cola en vivo), caja por método, incentivos y cobranza.
// Idempotente: borra los demo previos (notes='RELAY_DEMO'). Reutilizable + CLI:
//   node src/scripts/seedRelayDemo.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import StockMovement from "../models/StockMovement.js";
import { ORDER_STATUS, PAYMENT_STATUS } from "../utils/constants.js";

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const VEND = ["Susana Silva", "Matías Soto", "Patricia Díaz", "Jorge Rivas", "Camila Toro"];
const CAJ = ["Cajera Ana", "Cajera Bea", "Cajero Iván"];
const BOD = ["Bodeguero Luis", "Bodeguera Caro", "Bodeguero Tomás"];
// IDs estables por vendedor (dentro de la corrida): atribuyen Order.seller y alimentan
// Podio de vendedores, Top vendedores e INCENTIVOS (el gancho comercial).
const SELLER_IDS = Object.fromEntries(VEND.map((v) => [v, new mongoose.Types.ObjectId()]));
// Clientes verosímiles para que las tablas no repitan "Cliente Demo".
const CLIENTES = [
  "Minimarket La Esquina", "Almacén Don Pepe", "Botillería El Roble", "Kiosco Sur",
  "Distribuidora Aurora", "Comercial Las Nieves", "Panadería San Juan", "Almacén La Familia",
  "Minimarket El Trébol", "Verdulería Fresca", "Bazar Central", "Rotisería El Buen Gusto",
  "Almacén Doña Rosa", "Minimarket 24/7", "Comercial El Ahorro", "Feria Puesto 12",
];
const METODOS = ["cash_on_pickup", "cash_on_pickup", "cash_on_pickup", "transfer", "transfer", "card"]; // ~50/33/17
const HORAS = [9, 10, 11, 12, 12, 13, 13, 16, 17, 18, 18, 19, 19, 20]; // peaks mediodía y tarde

const boxTier = (p) => (p.pricing?.tiers || []).reduce((a, t) => ((t.min_qty || 1) > (a?.min_qty || 0) ? t : a), null);
const boxQtyDe = (p) => (boxTier(p)?.min_qty) || 1;
const unitPriceDe = (p) => (boxTier(p)?.price) || (p.pricing?.tiers?.[0]?.price) || 1000;

const armarItems = (productos) => {
  const n = rnd(1, 4);
  const items = [];
  let subtotal = 0;
  for (let k = 0; k < n; k++) {
    const p = pick(productos);
    const bq = boxQtyDe(p), unit = unitPriceDe(p);
    const cajas = rnd(1, 3);
    const quantity = cajas * bq;
    const sub = quantity * unit;
    items.push({ product_id: p._id, name: p.name, quantity, price: unit, subtotal: sub, sector: p.location?.sector || "", product_type: "simple" });
    subtotal += sub;
  }
  return { items, subtotal };
};

// COLAS LIMPIAS para demo: 1-2 pedidos por cola (pedido del CEO 2026-07-09) — el
// histórico sigue grande (alimenta reportes), pero las colas vivas quedan sin ruido:
// enCurso=4 (1 por etapa), agendados=1 (listo), grandes=1 (gateo de niveles).
export async function seedRelayDemo({ historicos = 90, dias = 75, enCurso = 4, agendados = 1, grandesEnCola = 1, cobranza = true } = {}) {
  await Order.deleteMany({ notes: "RELAY_DEMO" });
  await StockMovement.deleteMany({ reason: "RELAY_DEMO" });

  const productos = await Product.find({ is_active: true }).select("name pricing location cost_price").limit(60).lean();
  if (!productos.length) return { creados: 0 };

  // 1. Costos (~60-75% del precio de caja) donde falten + vencimientos próximos (FEFO).
  for (let i = 0; i < productos.length; i++) {
    const p = productos[i];
    const set = {};
    if (!(p.cost_price > 0)) set.cost_price = Math.max(1, Math.round(unitPriceDe(p) * (0.6 + (i % 4) * 0.04)));
    // Vencimientos: 10 productos; los primeros 6 dentro de 7 días (rojo/ámbar en FEFO), el resto más lejos.
    if (i < 10) { const dd = new Date(); dd.setDate(dd.getDate() + (i < 6 ? 1 + i : 10 + (i - 6) * 6)); set.expiry_date = dd; }
    if (Object.keys(set).length) await Product.updateOne({ _id: p._id }, { $set: set });
  }

  let creados = 0;

  // 2. Pedidos históricos ENTREGADOS, distribuidos en los últimos `dias`.
  for (let i = 0; i < historicos; i++) {
    const { items, subtotal } = armarItems(productos);
    // Forzar ~10 entregados HOY para que el periodo "Hoy" (ventas, tiempos, cuello) tenga datos.
    const diaAtras = i < 10 ? 0 : rnd(0, dias);
    const base = new Date(); base.setDate(base.getDate() - diaAtras);
    const hora = pick(HORAS);
    const t0 = new Date(base); t0.setHours(hora, rnd(0, 55), 0, 0);
    const tPaid = new Date(t0.getTime() + rnd(1, 6) * 60000);
    const tPrep = new Date(tPaid.getTime() + rnd(1, 12) * 60000);
    const tReady = new Date(tPrep.getTime() + rnd(4, 18) * 60000);
    const tDeli = new Date(tReady.getTime() + rnd(1, 7) * 60000);
    const metodo = pick(METODOS);
    const vendedor = pick(VEND), cajera = pick(CAJ), bodeguero = pick(BOD);

    const [o] = await Order.create([{
      items, customer: { fullName: pick(CLIENTES) }, seller: { id: SELLER_IDS[vendedor], nombre: vendedor },
      source: "manual", delivery_method: "pickup",
      pickup: { committed_date: t0, picked_up_at: tDeli },
      payment: { method: metodo, status: PAYMENT_STATUS.APPROVED, amount: subtotal,
        amount_received: metodo === "cash_on_pickup" ? Math.ceil(subtotal / 1000) * 1000 : null,
        change: metodo === "cash_on_pickup" ? Math.ceil(subtotal / 1000) * 1000 - subtotal : null },
      subtotal, shipping_amount: 0, discount_amount: 0, total: subtotal,
      status: ORDER_STATUS.DELIVERED, stock_committed: true, notes: "RELAY_DEMO",
    }]);
    await Order.collection.updateOne({ _id: o._id }, { $set: {
      created_at: t0, paid_at: tPaid, delivered_at: tDeli,
      status_history: [
        { status: "pending", changed_at: t0, note: "Tomado en sala", changed_by: { label: vendedor, role: "vendedor" } },
        { status: "paid", changed_at: tPaid, note: "Cobrado", changed_by: { label: cajera, role: "cashier" } },
        { status: "preparing", changed_at: tPrep, note: "Picking aceptado", changed_by: { label: bodeguero, role: "operator" } },
        { status: "ready", changed_at: tReady, note: "Listo", changed_by: { label: bodeguero, role: "operator" } },
        { status: "delivered", changed_at: tDeli, note: "Entregado", changed_by: { label: cajera, role: "cashier" } },
      ],
    } });
    creados++;
  }

  // 3. Pedidos EN CURSO (cola viva): distintas etapas, hoy.
  const ETAPAS = ["pending", "paid", "preparing", "ready"];
  for (let i = 0; i < enCurso; i++) {
    const { items, subtotal } = armarItems(productos);
    const estado = ETAPAS[i % ETAPAS.length];
    const t0 = new Date(Date.now() - rnd(5, 90) * 60000);
    const vendedor = pick(VEND), cajera = pick(CAJ), bodeguero = pick(BOD);
    const hist = [{ status: "pending", changed_at: t0, note: "Tomado en sala", changed_by: { label: vendedor, role: "vendedor" } }];
    if (estado !== "pending") hist.push({ status: "paid", changed_at: new Date(t0.getTime() + 3 * 60000), note: "Cobrado", changed_by: { label: cajera, role: "cashier" } });
    if (estado === "preparing" || estado === "ready") hist.push({ status: "preparing", changed_at: new Date(t0.getTime() + 8 * 60000), note: "Picking", changed_by: { label: bodeguero, role: "operator" } });
    if (estado === "ready") hist.push({ status: "ready", changed_at: new Date(t0.getTime() + 20 * 60000), note: "Listo", changed_by: { label: bodeguero, role: "operator" } });

    const [o] = await Order.create([{
      items, customer: { fullName: pick(CLIENTES) }, seller: { id: SELLER_IDS[vendedor], nombre: vendedor },
      source: "manual", delivery_method: "pickup",
      pickup: { committed_date: t0 },
      payment: { method: "cash_on_pickup", status: estado === "pending" ? PAYMENT_STATUS.PENDING : PAYMENT_STATUS.APPROVED, amount: subtotal },
      subtotal, shipping_amount: 0, discount_amount: 0, total: subtotal,
      status: estado, codigo_escaneo: `DEMO-${Date.now()}-${i}`, notes: "RELAY_DEMO",
    }]);
    await Order.collection.updateOne({ _id: o._id }, { $set: { created_at: t0, paid_at: estado !== "pending" ? hist[1]?.changed_at : null, status_history: hist } });
    creados++;
  }

  // 3b. Pedidos AGENDADOS para los próximos días → Calendario de retiros. OJO: los
  //     agendados "paid" también aparecen en la cola del tótem (lista todo paid), por
  //     eso el default es 1 y LISTO (ready no ensucia la cola de picking).
  for (let i = 0; i < agendados; i++) {
    const { items, subtotal } = armarItems(productos);
    const diaAdel = 1 + (i % 6); // 1..6 días hacia adelante
    const fecha = new Date(); fecha.setDate(fecha.getDate() + diaAdel); fecha.setHours(pick(HORAS), rnd(0, 55), 0, 0);
    const t0 = new Date(Date.now() - rnd(30, 300) * 60000);
    const vendedor = pick(VEND), cajera = pick(CAJ);
    const listo = i === 0; // el primero ya preparado esperando retiro; el resto pagado
    const [o] = await Order.create([{
      items, customer: { fullName: pick(CLIENTES) }, seller: { id: SELLER_IDS[vendedor], nombre: vendedor },
      source: "manual", delivery_method: "pickup",
      pickup: { committed_date: fecha },
      payment: { method: pick(METODOS), status: PAYMENT_STATUS.APPROVED, amount: subtotal },
      subtotal, shipping_amount: 0, discount_amount: 0, total: subtotal,
      status: listo ? ORDER_STATUS.READY : ORDER_STATUS.PAID, stock_committed: listo, notes: "RELAY_DEMO",
    }]);
    const hist = [
      { status: "pending", changed_at: t0, note: "Tomado en sala", changed_by: { label: vendedor, role: "vendedor" } },
      { status: "paid", changed_at: new Date(t0.getTime() + 3 * 60000), note: "Cobrado — retiro agendado", changed_by: { label: cajera, role: "cashier" } },
    ];
    if (listo) hist.push({ status: "ready", changed_at: new Date(t0.getTime() + 25 * 60000), note: "Listo para retiro", changed_by: { label: pick(BOD), role: "operator" } });
    await Order.collection.updateOne({ _id: o._id }, { $set: { created_at: t0, paid_at: hist[1].changed_at, status_history: hist } });
    creados++;
  }

  // 3c. Pedido(s) GRANDE(s) en cola (paid) para que el tótem/niveles muestre el
  //     gateo: el picker EXPERTO lo ve (primero); el NUEVO no lo ve. Grande por
  //     nº de líneas (>10 SKU) → garantizado sin depender de precios.
  for (let g = 0; g < grandesEnCola; g++) {
    const items = [];
    let subtotal = 0;
    for (let k = 0; k < 12; k++) {
      const p = pick(productos);
      const bq = boxQtyDe(p), unit = unitPriceDe(p), cajas = rnd(1, 2);
      const quantity = cajas * bq, sub = quantity * unit;
      items.push({ product_id: p._id, name: p.name, quantity, price: unit, cajas, box_qty: bq, subtotal: sub, sector: p.location?.sector || "", product_type: "simple" });
      subtotal += sub;
    }
    const t0 = new Date(Date.now() - rnd(5, 40) * 60000);
    const vendedor = pick(VEND), cajera = pick(CAJ);
    const [o] = await Order.create([{
      items, customer: { fullName: pick(CLIENTES) }, seller: { id: SELLER_IDS[vendedor], nombre: vendedor },
      source: "manual", delivery_method: "pickup", pickup: { committed_date: t0 },
      payment: { method: "cash_on_pickup", status: PAYMENT_STATUS.APPROVED, amount: subtotal },
      subtotal, shipping_amount: 0, discount_amount: 0, total: subtotal, status: ORDER_STATUS.PAID, notes: "RELAY_DEMO",
    }]);
    await Order.collection.updateOne({ _id: o._id }, { $set: { created_at: t0, paid_at: new Date(t0.getTime() + 3 * 60000), status_history: [
      { status: "pending", changed_at: t0, note: "Tomado en sala", changed_by: { label: vendedor, role: "vendedor" } },
      { status: "paid", changed_at: new Date(t0.getTime() + 3 * 60000), note: "Cobrado", changed_by: { label: cajera, role: "cashier" } },
    ] } });
    creados++;
  }

  // 4. Compras (recepciones de mercadería) → egreso de inventario para Finanzas.
  const movs = [];
  for (let i = 0; i < 28; i++) {
    const p = pick(productos);
    const dd = new Date(); dd.setDate(dd.getDate() - rnd(0, dias)); dd.setHours(rnd(8, 18), rnd(0, 59), 0, 0);
    movs.push({ product_id: p._id, product_name: p.name, type: "recepcion", quantity: rnd(20, 200), stock_after: null, reason: "RELAY_DEMO", by: { label: "Recepción demo", role: null, user_id: null }, created_at: dd });
  }
  try { await StockMovement.collection.insertMany(movs); } catch { /* opcional */ }

  // 5. Cobranza (clientes + deudas ligadas + cheques). El orquestador seedDemoAll
  //    la maneja aparte (cobranza:false) para controlar el orden; standalone la corre.
  if (cobranza) {
    try {
      const { seedDemoCobranza } = await import("./seedDemoCobranza.js");
      await seedDemoCobranza();
    } catch { /* opcional */ }
  }

  return { creados, historicos, enCurso };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/seedRelayDemo.js")) {
  dotenv.config();
  mongoose.connect(process.env.MONGO_URI)
    .then(() => seedRelayDemo())
    .then((r) => { console.log(`📈 Demo sembrada: ${r.creados} pedidos (${r.historicos} históricos + ${r.enCurso} en curso) + costos/vencimientos + cobranza`); process.exit(0); })
    .catch((e) => { console.error("❌", e); process.exit(1); });
}
