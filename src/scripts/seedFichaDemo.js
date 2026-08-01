import mongoose from "mongoose";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import StockMovement from "../models/StockMovement.js";
import Batch from "../models/Batch.js";
import User from "../models/User.js";
import { logger } from "../utils/logger.js";

// ── Seed de DEMO para las fichas técnicas ─────────────────────────────────────
// Fabrica historia COHERENTE para que la demo se vea completa:
//  • pedidos ENTREGADOS repartidos en los últimos 30 días (con historia de
//    estados y método de pago) → Gerencia/Ventas/Cierre Z ven lo mismo…
//  • …y su kardex de venta (StockMovement) → la serie de la ficha ve lo mismo.
//  • LOTES abiertos que SUMAN el stock actual de cada producto (ingresos
//    escalonados y vencimientos variados) → ficha/FEFO/Lotes con datos.
//  • min_stock/target_stock en un subconjunto → Reposición con casos.
// NO toca el stock físico (la historia es ficticia; el stock actual manda).
// Idempotente razonable: no duplica lotes si ya existen; la historia se marca
// con demo_seed:"ficha" y se puede re-ejecutar (borra la suya y la rehace).

const DAY = 24 * 60 * 60 * 1000;
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const CLIENTES = [
  "Minimarket La Esquina", "Almacén Doña Rosa", "Kiosco San Pedro", "Botillería El Trébol",
  "Minimarket Los Aromos", "Almacén La Vega Chica", "Rotisería Don Manuel", "Cliente mostrador",
  "Bazar y Almacén Lucía", "Minimarket El Sol", "Amasandería La Espiga", "Almacén El Vecino",
];

const boxQtyOf = (p) => {
  const tiers = p?.pricing?.tiers || [];
  return Math.max(1, ...tiers.map((t) => Number(t.min_qty) || 1));
};
const unitPriceOf = (p) => {
  const tiers = [...(p?.pricing?.tiers || [])].sort((a, b) => (b.min_qty || 1) - (a.min_qty || 1));
  return Number((tiers[0] || {}).price || p?.pricing?.min_price || 0); // precio por caja (mayorista)
};

export async function seedFichaDemo() {
  const productos = await Product.find({ is_active: true })
    .select("name stock cost_price pricing location expiry_date min_stock target_stock")
    .lean();
  if (!productos.length) return { ok: false, error: "sin productos activos" };

  const vendedor = await User.findOne({ email: /vendedor/i }).select("_id name").lean();
  const cajera = await User.findOne({ email: /cajero/i }).select("_id name email").lean();
  const bodeguero = await User.findOne({ email: /operario/i }).select("_id name email").lean();
  const sellerId = vendedor?._id || cajera?._id || productos[0]._id; // algo estable
  const sellerNombre = vendedor?.name || "Vendedor de Sala";
  const lblCajera = cajera?.name || cajera?.email || "Cajera";
  const lblBodeguero = bodeguero?.name || bodeguero?.email || "Bodeguero";

  // ── 0. Limpiar historia demo previa de ESTE seed (re-ejecutable) ───────────
  // OJO: driver crudo a propósito — demo_seed no está en el schema y un
  // strictQuery podría descartar el filtro en Mongoose (borraría TODO).
  const prevOrders = await Order.collection.find({ demo_seed: "ficha" }, { projection: { _id: 1 } }).toArray();
  if (prevOrders.length) {
    const ids = prevOrders.map((o) => o._id);
    await StockMovement.collection.deleteMany({ order_id: { $in: ids } });
    await Order.collection.deleteMany({ demo_seed: "ficha" });
  }

  // ── 1. Historia de ventas: pedidos entregados repartidos en 30 días ────────
  // Peso por producto: los primeros de la lista venden más (ranking estable y
  // "Jugo en polvo" —si existe— se fuerza al tope para calzar con la demo).
  const orden = [...productos].sort((a, b) => (b.stock || 0) - (a.stock || 0));
  const idxJugo = orden.findIndex((p) => /jugo en polvo/i.test(p.name));
  if (idxJugo > 0) orden.unshift(orden.splice(idxJugo, 1)[0]);
  const weight = (i) => Math.max(1, Math.round(24 * Math.exp(-i / 9))); // exponencial suave
  const bolsa = [];
  orden.forEach((p, i) => { for (let k = 0; k < weight(i); k++) bolsa.push(p); });

  const ordersDocs = [];
  const movDocs = [];
  const now = Date.now();
  for (let d = 30; d >= 1; d--) {
    const esDomingo = new Date(now - d * DAY).getDay() === 0;
    if (esDomingo && Math.random() < 0.7) continue; // domingos casi sin venta
    const nPedidos = ri(2, 5) - (esDomingo ? 1 : 0);
    for (let n = 0; n < nPedidos; n++) {
      const base = new Date(now - d * DAY);
      base.setHours(ri(9, 18), ri(0, 59), ri(0, 59), 0);
      const created = base.getTime();
      const paidAt = created + ri(4, 18) * 60_000;
      const prepAt = paidAt + ri(2, 8) * 60_000;
      const readyAt = prepAt + ri(8, 25) * 60_000;
      const deliveredAt = readyAt + ri(3, 15) * 60_000;

      // 1-4 productos distintos por pedido, en cajas
      const elegidos = new Map();
      for (let k = 0, tope = ri(1, 4); k < tope; k++) {
        const p = pick(bolsa);
        if (!elegidos.has(String(p._id))) elegidos.set(String(p._id), p);
      }
      const items = [];
      for (const p of elegidos.values()) {
        const box = boxQtyOf(p);
        const cajas = ri(1, 3);
        const qty = cajas * box;
        const precio = unitPriceOf(p);
        items.push({
          product_id: p._id, name: p.name, quantity: qty, cajas, box_qty: box,
          price: precio, subtotal: precio * qty, sector: p.location?.sector || "",
          product_type: "simple",
        });
      }
      const total = items.reduce((a, it) => a + it.subtotal, 0);
      if (total <= 0) continue;
      const metodo = Math.random() < 0.55 ? "cash_on_pickup" : Math.random() < 0.6 ? "card" : "transfer";
      const oid = new mongoose.Types.ObjectId();
      ordersDocs.push({
        _id: oid,
        demo_seed: "ficha",
        source: "manual",
        delivery_method: "pickup",
        status: "delivered",
        customer: { fullName: pick(CLIENTES) },
        seller: { id: sellerId, nombre: sellerNombre },
        codigo_escaneo: String(oid),
        items,
        total,
        payment: { method: metodo, status: "approved", cashier_id: cajera?._id || null },
        created_at: new Date(created),
        updated_at: new Date(deliveredAt),
        paid_at: new Date(paidAt),
        delivered_at: new Date(deliveredAt),
        stock_committed: true, // histórico: no debe volver a descontar stock
        status_history: [
          { status: "pending", changed_at: new Date(created), changed_by: { label: sellerNombre, role: "vendedor" } },
          { status: "paid", changed_at: new Date(paidAt), changed_by: { label: lblCajera, role: "cashier" } },
          { status: "preparing", changed_at: new Date(prepAt), changed_by: { label: lblBodeguero, role: "operator" } },
          { status: "ready", changed_at: new Date(readyAt), changed_by: { label: lblBodeguero, role: "operator" } },
          { status: "delivered", changed_at: new Date(deliveredAt), changed_by: { label: lblCajera, role: "cashier" } },
        ],
      });
      for (const it of items) {
        movDocs.push({
          product_id: it.product_id, product_name: it.name, order_id: oid,
          type: "venta", quantity: -it.quantity, stock_after: null,
          reason: "Venta demo (seed ficha)", by: { user_id: null, role: "system", label: "demo" },
          created_at: new Date(deliveredAt),
        });
      }
    }
  }
  if (ordersDocs.length) {
    await Order.collection.insertMany(ordersDocs, { ordered: false });
    await StockMovement.collection.insertMany(movDocs, { ordered: false });
  }

  // ── 2. Lotes que SUMAN el stock actual (solo productos sin lotes open) ─────
  const conLote = new Set((await Batch.distinct("product_id", { status: "open" })).map(String));
  const batchDocs = [];
  let productosConLoteNuevo = 0;
  const ymd = (t) => { const x = new Date(t); return `${String(x.getFullYear()).slice(2)}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`; };
  for (const p of productos) {
    if (!(p.stock > 0) || conLote.has(String(p._id))) continue;
    const nLotes = p.stock >= 60 ? ri(2, 3) : 1;
    // repartir el stock entre lotes (el último se lleva el resto exacto)
    let restante = p.stock;
    const cortes = [];
    for (let i = 0; i < nLotes - 1; i++) {
      const parte = Math.max(1, Math.round(restante * (0.3 + Math.random() * 0.3)));
      cortes.push(parte); restante -= parte;
    }
    cortes.push(restante);
    const costo = Number(p.cost_price) > 0 ? Number(p.cost_price) : Math.round(unitPriceOf(p) * 0.68);
    let recAgo = ri(25, 45); // el lote más viejo
    for (let i = 0; i < cortes.length; i++) {
      const receivedAt = new Date(now - recAgo * DAY);
      // vencimiento: entre 20 y 160 días; ~1 de cada 5 lotes vence "pronto" (<30 d)
      const vence = Math.random() < 0.2 ? ri(8, 28) : ri(35, 160);
      batchDocs.push({
        product_id: p._id, product_name: p.name,
        lot_code: `L${ymd(receivedAt.getTime())}-${ri(10, 99)}`,
        qty_received: cortes[i], qty_remaining: cortes[i],
        unit_cost: Math.max(1, Math.round(costo * (0.95 + Math.random() * 0.1))),
        expiry_date: new Date(now + vence * DAY),
        location: p.location || {}, supplier: pick(["Distribuidora Sur", "Alimentos Andes", "Comercial Pacífico"]),
        doc_ref: `F-${ri(1000, 9999)}`, status: "open",
        received_at: receivedAt, received_by: { user_id: null, role: "system", label: "demo" },
        created_at: receivedAt, updated_at: receivedAt,
      });
      recAgo = Math.max(2, recAgo - ri(8, 16)); // lotes siguientes más nuevos
    }
    productosConLoteNuevo++;
  }
  if (batchDocs.length) await Batch.collection.insertMany(batchDocs, { ordered: false });

  // Product.expiry_date = menor vencimiento de sus lotes open (coherencia FEFO)
  const agg = await Batch.aggregate([
    { $match: { status: "open", expiry_date: mongoose.trusted({ $ne: null }) } },
    { $group: { _id: "$product_id", min: { $min: "$expiry_date" } } },
  ]);
  for (const a of agg) await Product.updateOne({ _id: a._id }, { $set: { expiry_date: a.min } });

  // ── 3. Reposición: mínimos en un subconjunto (3-5 bajo mínimo a propósito) ─
  const sinMin = productos.filter((p) => !(p.min_stock > 0));
  const candidatos = [...sinMin].sort((a, b) => (a.stock || 0) - (b.stock || 0));
  let bajoMinimo = 0, conMinimo = 0;
  for (let i = 0; i < candidatos.length && conMinimo < 14; i++) {
    const p = candidatos[i];
    const box = boxQtyOf(p);
    let min;
    if (bajoMinimo < 4) { min = Math.max(box, Math.ceil(((p.stock || 0) + box * 2) / box) * box); bajoMinimo++; } // queda BAJO mínimo
    else { min = Math.max(box, Math.floor((p.stock || 1) * 0.3 / box) * box); if (!(min > 0)) continue; }
    await Product.updateOne({ _id: p._id }, { $set: { min_stock: min, target_stock: min * 3 } });
    conMinimo++;
  }

  const out = {
    ok: true,
    pedidos_demo: ordersDocs.length,
    movimientos: movDocs.length,
    lotes: batchDocs.length,
    productos_con_lote_nuevo: productosConLoteNuevo,
    minimos_seteados: conMinimo,
    bajo_minimo: bajoMinimo,
  };
  logger.info(out, "seedFichaDemo: demo de fichas sembrada");
  return out;
}

export default seedFichaDemo;
