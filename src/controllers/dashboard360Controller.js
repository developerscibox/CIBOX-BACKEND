import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Batch from "../models/Batch.js";
import StockMovement from "../models/StockMovement.js";
import { ORDER_STATUS, PAID_STATUSES, MOVEMENT_TYPES } from "../utils/constants.js";

// Dashboard Gerencial 360°: GET /gerencia/dashboard360. Foto ejecutiva del DÍA +
// mes calendario en un solo endpoint. Todo son datos REALES derivados de
// Order/Product/Batch/StockMovement; lo que no existe viene en 0/[]/null, nunca
// se inventa. Devuelve números crudos: el front formatea.

// ── Helpers (mismo criterio que /gerencia) ──
const firstTs = (hist, status) => {
  const h = (hist || []).find((x) => x.status === status);
  return h ? new Date(h.changed_at).getTime() : null;
};
const actorOf = (hist, status) => {
  const h = (hist || []).find((x) => x.status === status);
  return h?.changed_by?.label || null;
};
const mins = (a, b) => (a != null && b != null && b >= a ? (b - a) / 60000 : null);
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const TZ = "America/Santiago"; // agregaciones por día en hora chilena, no UTC

// YYYY-MM-DD en hora LOCAL del servidor (coherente con los límites de día
// new Date("YYYY-MM-DDT00:00:00.000"), que también son locales).
const ymdLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayStart = (ymd) => new Date(`${ymd}T00:00:00.000`);
const dayEnd = (ymd) => new Date(`${ymd}T23:59:59.999`);

// Mismo criterio que /gerencia: "vendido" = pedidos en estado pagado o posterior,
// por fecha de creación del pedido.
const paidMatch = (s, e) => ({ status: { $in: PAID_STATUSES }, created_at: { $gte: s, $lte: e } });

// Expresión de agregación: costo unitario de valorización = cost_price si > 0,
// si no pricing.min_price (proxy de valor de venta, mismo fallback que el
// panorama de inventario /inventory/stock-summary).
const COSTO_VALORIZACION = {
  $cond: [
    { $gt: [{ $ifNull: ["$p.cost_price", 0] }, 0] },
    "$p.cost_price",
    { $ifNull: ["$p.pricing.min_price", 0] },
  ],
};

export const getDashboard360 = asyncHandler(async (req, res) => {
  const now = new Date();
  const hoyYmd = ymdLocal(now);
  const hoy0 = dayStart(hoyYmd);
  const hoy1 = dayEnd(hoyYmd);
  const ayerYmd = ymdLocal(new Date(hoy0.getTime() - 1));
  const ayer0 = dayStart(ayerYmd);

  // Últimos 12 días (incluye hoy) para los sparklines.
  const SPARK_DIAS = 12;
  const sparkDias = Array.from({ length: SPARK_DIAS }, (_, i) => {
    const d = new Date(hoy0);
    d.setDate(d.getDate() - (SPARK_DIAS - 1 - i));
    return ymdLocal(d);
  });
  const spark0 = dayStart(sparkDias[0]);

  // Mes calendario actual (día 1 → hoy) y mismos días 1..N del mes anterior.
  const mes0 = new Date(now.getFullYear(), now.getMonth(), 1);
  const diasEnPrev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const prevDia = Math.min(now.getDate(), diasEnPrev);
  const prev0 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prev1 = new Date(now.getFullYear(), now.getMonth() - 1, prevDia, 23, 59, 59, 999);

  const d30 = new Date(now.getTime() - 30 * 86400000);
  const d60 = new Date(now.getTime() - 60 * 86400000);
  const v7 = new Date(now.getTime() + 7 * 86400000);

  const [
    ventas12Agg,
    margenDiaAgg,
    ingresados12Agg,
    entregados12Agg,
    colaAgg,
    preparandoDocs,
    prods,
    porVencer7d,
    mermaAgg,
    mesAgg,
    mesItemsAgg,
    prevMesAgg,
    units30Agg,
    comprasAgg,
    deliveredHoy,
  ] = await Promise.all([
    // Venta por día, últimos 12 días (cubre hoy/ayer + sparkVentas). Mismo criterio que /gerencia.
    Order.aggregate([
      { $match: paidMatch(spark0, hoy1) },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ } }, total: { $sum: "$total" } } },
    ]),
    // Margen de lo vendido hoy/ayer: solo ítems con costo conocido (cost_price > 0).
    Order.aggregate([
      { $match: paidMatch(ayer0, hoy1) },
      { $unwind: "$items" },
      { $lookup: { from: "products", localField: "items.product_id", foreignField: "_id", as: "p" } },
      { $addFields: { cost: { $ifNull: [{ $arrayElemAt: ["$p.cost_price", 0] }, 0] } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ } },
          revC: { $sum: { $cond: [{ $gt: ["$cost", 0] }, "$items.subtotal", 0] } },
          costC: { $sum: { $cond: [{ $gt: ["$cost", 0] }, { $multiply: ["$cost", "$items.quantity"] }, 0] } },
        },
      },
    ]),
    // Pedidos creados por día (excluye cancelados), últimos 12 días.
    Order.aggregate([
      { $match: { status: { $ne: ORDER_STATUS.CANCELLED }, created_at: { $gte: spark0, $lte: hoy1 } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ } }, n: { $sum: 1 } } },
    ]),
    // Entregados por día (por delivered_at, mismo criterio que /gerencia), últimos 12 días.
    Order.aggregate([
      { $match: { status: ORDER_STATUS.DELIVERED, delivered_at: { $gte: spark0, $lte: hoy1 } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$delivered_at", timezone: TZ } }, n: { $sum: 1 } } },
    ]),
    // Cola actual (en vivo) por estado.
    Order.aggregate([
      { $match: { status: { $in: ["pending", "paid", "preparing", "ready"] } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
    // En preparación AHORA → atrasados = llevan > 30 min desde que entraron a preparing.
    Order.find({ status: ORDER_STATUS.PREPARING }).select("status_history").lean(),
    // Inventario activo: valorización, críticos, sin stock, categorías, unidades.
    Product.find({ is_active: true }).select("stock min_stock cost_price pricing.min_price category.name").lean(),
    // Lotes open (qty_remaining > 0 por hook de status) con vencimiento ≤ 7 días,
    // incluye ya vencidos — mismo criterio FEFO que /inventory/lotes/expiring.
    Batch.countDocuments({ status: "open", expiry_date: mongoose.trusted({ $ne: null, $lte: v7 }) }),
    // Merma del mes: ajustes NEGATIVOS del kardex cuyo motivo menciona "merma"
    // (la merma no tiene tipo propio: es MOVEMENT_TYPES.ADJUSTMENT con motivo libre).
    // Valorizada a cost_price y, si el producto no tiene costo, a pricing.min_price.
    StockMovement.aggregate([
      {
        $match: {
          type: MOVEMENT_TYPES.ADJUSTMENT,
          quantity: { $lt: 0 },
          created_at: { $gte: mes0, $lte: hoy1 },
          reason: { $regex: "merma", $options: "i" },
        },
      },
      { $lookup: { from: "products", localField: "product_id", foreignField: "_id", as: "p" } },
      { $unwind: { path: "$p", preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, total: { $sum: { $multiply: [{ $abs: "$quantity" }, COSTO_VALORIZACION] } } } },
    ]),
    // Ventas del mes: total/pedidos + serie por día. Mismo criterio que /gerencia.
    Order.aggregate([
      { $match: paidMatch(mes0, hoy1) },
      {
        $facet: {
          totals: [{ $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }],
          porDia: [
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ } }, monto: { $sum: "$total" } } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]),
    // Ítems vendidos del mes por producto + costo y categoría (top, margen, rotación).
    Order.aggregate([
      { $match: paidMatch(mes0, hoy1) },
      { $unwind: "$items" },
      { $group: { _id: "$items.product_id", name: { $first: "$items.name" }, qty: { $sum: "$items.quantity" }, revenue: { $sum: "$items.subtotal" } } },
      { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "p" } },
      {
        $addFields: {
          cost: { $ifNull: [{ $arrayElemAt: ["$p.cost_price", 0] }, 0] },
          categoria: { $ifNull: [{ $arrayElemAt: ["$p.category.name", 0] }, "Sin categoría"] },
        },
      },
      { $project: { name: 1, qty: 1, revenue: 1, categoria: 1, costo: { $multiply: ["$cost", "$qty"] } } },
    ]),
    // Mes anterior, mismos días 1..N (comparativa total y ticket).
    Order.aggregate([
      { $match: paidMatch(prev0, prev1) },
      { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    // Unidades vendidas en los últimos 30 días (cobertura de stock en días).
    Order.aggregate([
      { $match: paidMatch(d30, hoy1) },
      { $unwind: "$items" },
      { $group: { _id: null, unidades: { $sum: "$items.quantity" } } },
    ]),
    // Abastecimiento desde LOTES (Batch): recepciones valorizadas a qty_received ×
    // unit_cost del lote. Batch SÍ tiene supplier y costo por lote; lotes sin costo
    // suman 0 (honesto, no se inventa). prev = ventana -60d..-30d para comparar.
    Batch.aggregate([
      { $match: { received_at: { $gte: d60 } } },
      {
        $facet: {
          cur: [
            { $match: { received_at: { $gte: d30 } } },
            { $lookup: { from: "products", localField: "product_id", foreignField: "_id", as: "p" } },
            {
              $project: {
                monto: { $multiply: ["$qty_received", { $ifNull: ["$unit_cost", 0] }] },
                categoria: { $ifNull: [{ $arrayElemAt: ["$p.category.name", 0] }, "Sin categoría"] },
                // Proveedor: el del lote; si viene vacío, el vendor del producto.
                proveedor: {
                  $cond: [
                    { $gt: [{ $strLenCP: { $ifNull: ["$supplier", ""] } }, 0] },
                    "$supplier",
                    { $ifNull: [{ $arrayElemAt: ["$p.vendor.name", 0] }, "Sin proveedor"] },
                  ],
                },
              },
            },
          ],
          prev: [
            { $match: { received_at: { $lt: d30 } } },
            { $group: { _id: null, monto: { $sum: { $multiply: ["$qty_received", { $ifNull: ["$unit_cost", 0] }] } } } },
          ],
        },
      },
    ]),
    // Entregados HOY con historial → tiempos del día, SLA y productividad de preparación.
    Order.find({ status: ORDER_STATUS.DELIVERED, delivered_at: mongoose.trusted({ $gte: hoy0, $lte: hoy1 }) })
      .select("total created_at delivered_at status_history").lean(),
  ]);

  // ── KPIs del día ──
  const mapBy = (rows, key = "_id") => Object.fromEntries(rows.map((x) => [x[key], x]));
  const ventasByDia = mapBy(ventas12Agg);
  const ingresadosByDia = mapBy(ingresados12Agg);
  const entregadosByDia = mapBy(entregados12Agg);
  const margenByDia = mapBy(margenDiaAgg);
  const margenPctDia = (ymd) => {
    const m = margenByDia[ymd];
    return m && m.revC > 0 ? Math.round(((m.revC - m.costC) / m.revC) * 100) : null; // null: nada con costo
  };

  const cola = { pending: 0, paid: 0, preparing: 0, ready: 0 };
  colaAgg.forEach((x) => {
    cola[x._id] = x.n;
  });

  // Atrasados: en preparación hace más de 30 minutos (por status_history).
  const LIMITE_ATRASO_MS = 30 * 60000;
  const atrasadosPreparacion = preparandoDocs.filter((o) => {
    const t = firstTs(o.status_history, "preparing");
    return t != null && now.getTime() - t > LIMITE_ATRASO_MS;
  }).length;

  const kpisDia = {
    ventasHoy: r0(ventasByDia[hoyYmd]?.total),
    ventasAyer: r0(ventasByDia[ayerYmd]?.total),
    margenBrutoPct: margenPctDia(hoyYmd),
    margenAyerPct: margenPctDia(ayerYmd),
    ingresados: ingresadosByDia[hoyYmd]?.n || 0,
    ingresadosAyer: ingresadosByDia[ayerYmd]?.n || 0,
    enPreparacion: cola.preparing,
    listos: cola.ready,
    entregados: entregadosByDia[hoyYmd]?.n || 0,
    entregadosAyer: entregadosByDia[ayerYmd]?.n || 0,
    sparkVentas: sparkDias.map((d) => r0(ventasByDia[d]?.total)),
    sparkIngresados: sparkDias.map((d) => ingresadosByDia[d]?.n || 0),
    sparkEntregados: sparkDias.map((d) => entregadosByDia[d]?.n || 0),
  };

  // ── Inventario (sobre productos activos) ──
  // stockCritico: criterio reorder (/inventory/reorder) = min_stock>0 y stock<=min_stock,
  // acotado aquí a stock>0 porque los agotados van aparte en sinStock.
  const stockCritico = prods.filter((p) => (p.min_stock || 0) > 0 && (p.stock || 0) > 0 && p.stock <= p.min_stock).length;
  const sinStock = prods.filter((p) => (p.stock || 0) <= 0).length;
  // Valorización: stock × (cost_price si > 0, si no pricing.min_price). El costo
  // real manda; el fallback a precio de venta mínimo es el mismo proxy que usa
  // /inventory/stock-summary para productos sin costo cargado.
  const valorDe = (p) => (p.stock || 0) * ((p.cost_price || 0) > 0 ? p.cost_price : p.pricing?.min_price || 0);
  const stockValorizado = r0(prods.reduce((a, p) => a + valorDe(p), 0));
  const stockUnidades = prods.reduce((a, p) => a + (p.stock || 0), 0);

  // Máx 6 filas EN TOTAL: top 5 por monto + "Otros" con el resto (si lo hay).
  const topConOtros = (rows, max) => {
    const sorted = [...rows].sort((a, b) => b.monto - a.monto);
    if (sorted.length <= max) return sorted;
    const top = sorted.slice(0, max - 1);
    const resto = sorted.slice(max - 1).reduce((a, x) => a + x.monto, 0);
    top.push({ nombre: "Otros", monto: r0(resto) });
    return top;
  };
  const catValor = {};
  prods.forEach((p) => {
    const c = p.category?.name || "Sin categoría";
    catValor[c] = (catValor[c] || 0) + valorDe(p);
  });
  const categorias = topConOtros(
    Object.entries(catValor).filter(([, v]) => v > 0).map(([nombre, v]) => ({ nombre, monto: r0(v) })),
    6,
  ).map((c) => ({ nombre: c.nombre, monto: c.monto, pct: stockValorizado ? Math.round((c.monto / stockValorizado) * 100) : 0 }));

  const units30 = units30Agg[0]?.unidades || 0;
  const coberturaDias = units30 > 0 ? Math.round(stockUnidades / (units30 / 30)) : null; // null: sin ventas 30d

  // ── Ventas del mes ──
  const mesTot = mesAgg[0]?.totals?.[0] || {};
  const totalMes = r0(mesTot.total);
  const pedidosMes = mesTot.count || 0;
  const prevTot = prevMesAgg[0] || {};
  const itemsMes = mesItemsAgg.map((x) => ({
    nombre: x.name,
    qty: x.qty,
    revenue: r0(x.revenue),
    costo: r0(x.costo),
    categoria: x.categoria,
  }));
  const unidadesMes = itemsMes.reduce((a, x) => a + x.qty, 0);
  const ventasMes = {
    total: totalMes,
    prevTotal: r0(prevTot.total),
    serie: (mesAgg[0]?.porDia || []).map((d) => ({ dia: d._id, monto: r0(d.monto) })),
    topProductos: [...itemsMes].sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((x) => ({ nombre: x.nombre, monto: x.revenue })),
  };

  const inventario = {
    stockValorizado,
    categorias,
    stockCritico,
    sinStock,
    coberturaDias,
    rotacionMes: stockUnidades > 0 ? r1(unidadesMes / stockUnidades) : null, // null: sin stock
  };

  // ── Abastecimiento (lotes de los últimos 30 días) ──
  const compras = comprasAgg[0] || {};
  const lotes30 = compras.cur || [];
  const compras30d = r0(lotes30.reduce((a, b) => a + (b.monto || 0), 0));
  const porCampo = (rows, campo) => {
    const acc = {};
    rows.forEach((x) => { acc[x[campo]] = (acc[x[campo]] || 0) + (x.monto || 0); });
    return Object.entries(acc).map(([nombre, monto]) => ({ nombre, monto: r0(monto) }));
  };
  const abastecimiento = {
    compras30d,
    comprasPrev30d: r0(compras.prev?.[0]?.monto),
    segmentos: topConOtros(porCampo(lotes30, "categoria").filter((x) => x.monto > 0), 6)
      .map((x) => ({ nombre: x.nombre, pct: compras30d ? Math.round((x.monto / compras30d) * 100) : 0 })),
    topProveedores: porCampo(lotes30, "proveedor").filter((x) => x.monto > 0).sort((a, b) => b.monto - a.monto).slice(0, 5),
  };

  // ── Logística + productividad (de los entregados de hoy) ──
  const tPrep = [];   // preparing → ready
  const tTotal = [];  // created → delivered
  const prepPorPersona = {};
  for (const o of deliveredHoy) {
    const created = new Date(o.created_at).getTime();
    const prep = firstTs(o.status_history, "preparing");
    const ready = firstTs(o.status_history, "ready");
    const del = firstTs(o.status_history, "delivered") || new Date(o.delivered_at).getTime();
    const pm = mins(prep, ready);
    const tot = mins(created, del);
    if (pm != null) tPrep.push(pm);
    if (tot != null) tTotal.push(tot);
    const b = actorOf(o.status_history, "preparing");
    if (b) {
      prepPorPersona[b] = prepPorPersona[b] || { nombre: b, pedidos: 0, _t: [] };
      prepPorPersona[b].pedidos++;
      if (pm != null) prepPorPersona[b]._t.push(pm);
    }
  }

  const SLA_MIN = 45; // objetivo: entregado en ≤ 45 min desde que se creó el pedido
  const logistica = {
    // Pipeline real del día: volúmenes de hoy en las puntas, colas EN VIVO al medio.
    etapas: [
      { etapa: "Ingresados", n: kpisDia.ingresados },
      { etapa: "Por pagar", n: cola.pending },
      { etapa: "Por preparar", n: cola.paid },
      { etapa: "En preparación", n: cola.preparing },
      { etapa: "Listos", n: cola.ready },
      { etapa: "Entregados", n: kpisDia.entregados },
    ],
    tiempos: {
      preparacionMin: tPrep.length ? r0(avg(tPrep)) : null,
      totalMin: tTotal.length ? r0(avg(tTotal)) : null,
    },
    atrasados: atrasadosPreparacion,
    // % de entregados de hoy (con tiempo total medible) dentro del SLA.
    slaPct: tTotal.length ? Math.round((tTotal.filter((t) => t <= SLA_MIN).length / tTotal.length) * 100) : null,
  };

  const productividad = {
    preparacion: Object.values(prepPorPersona)
      .map((x) => {
        const prom = avg(x._t); // exacto, antes de redondear, para pedidosHora
        return { nombre: x.nombre, pedidos: x.pedidos, tiempoPromMin: r0(prom), pedidosHora: prom > 0 ? r1(60 / prom) : null };
      })
      .sort((a, b) => b.pedidos - a.pedidos),
  };

  // ── Rentabilidad del mes (mismo criterio finanzas de /gerencia:
  // COGS = Σ costo×qty de lo vendido; margen = venta − COGS) ──
  const cogsMes = itemsMes.reduce((a, x) => a + x.costo, 0);
  const margenBruto = totalMes - cogsMes;
  const conCosto = itemsMes.filter((x) => x.costo > 0 && x.revenue > 0);
  const pctMargen = (rev, cost) => Math.round(((rev - cost) / rev) * 100);
  // Margen % por categoría de lo VENDIDO en el mes: solo ítems con costo conocido.
  const catAgg = {};
  conCosto.forEach((x) => {
    catAgg[x.categoria] = catAgg[x.categoria] || { rev: 0, cost: 0 };
    catAgg[x.categoria].rev += x.revenue;
    catAgg[x.categoria].cost += x.costo;
  });
  const mermaMes = r0(mermaAgg[0]?.total); // 0 si no hubo ajustes con motivo "merma"
  const rentabilidad = {
    margenBruto: r0(margenBruto),
    margenPct: totalMes ? Math.round((margenBruto / totalMes) * 100) : null,
    mermaMes,
    capitalInmovilizado: stockValorizado,
    ticket: pedidosMes ? r0(totalMes / pedidosMes) : 0,
    ticketPrev: prevTot.count ? r0(prevTot.total / prevTot.count) : 0,
    margenPorCategoria: Object.entries(catAgg)
      .map(([nombre, v]) => ({ nombre, pct: pctMargen(v.rev, v.cost) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6),
    margenPorProducto: conCosto
      .map((x) => ({ nombre: x.nombre, pct: pctMargen(x.revenue, x.costo) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5),
  };

  res.json({
    success: true,
    data: {
      fecha: hoyYmd,
      kpisDia,
      alertas: { stockCritico, sinStock, atrasadosPreparacion, porVencer7d, mermaMes },
      ventasMes,
      inventario,
      abastecimiento,
      logistica,
      productividad,
      rentabilidad,
    },
  });
});

export default { getDashboard360 };
