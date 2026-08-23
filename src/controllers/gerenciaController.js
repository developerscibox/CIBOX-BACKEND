import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import StockMovement from "../models/StockMovement.js";
import { ORDER_STATUS, PAID_STATUSES, MOVEMENT_TYPES } from "../utils/constants.js";
import { ymdChile, inicioDiaChile, finDiaChile } from "../utils/fechas.js";

// Centro de mando del gerente: un solo endpoint que agrega métricas REALES del
// negocio para un rango. Sin datos sintéticos: lo que no hay, viene en 0/[].
// Deriva todo de Order (status_history) + Product (cost_price). §5.5/§10/§11.

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
const TZ = "America/Santiago"; // agregaciones por día/hora en hora chilena, no UTC

export const getGerencia = asyncHandler(async (req, res) => {
  // Fechas y límites en hora de CHILE. Con toISOString (UTC) y límites en hora
  // del proceso (también UTC), el periodo "Hoy" consultado después de las 20:00
  // mostraba solo lo vendido a partir de esa hora y rotulaba la fecha de mañana,
  // mientras la serie diaria se agrupaba con timezone: TZ. Filtro y buckets
  // tienen que estar en la misma zona o los reportes pierden la tarde.
  const today = ymdChile();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today;
  const start = inicioDiaChile(from);
  const end = finDiaChile(to);
  const durMs = Math.max(1, end - start);
  const prevStart = new Date(start.getTime() - durMs);
  const prevEnd = new Date(start.getTime() - 1);
  const paidMatch = (s, e) => ({ status: { $in: PAID_STATUSES }, created_at: { $gte: s, $lte: e } });

  const [ventasAgg, prevAgg, prodAgg, deliveredDocs, colaAgg, cobrosAgg, quiebres, comprasAgg, pagosAgg] = await Promise.all([
    // Ventas del periodo: totales + serie por día + por hora
    Order.aggregate([
      { $match: paidMatch(start, end) },
      {
        $facet: {
          totals: [{ $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }],
          porDia: [
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ } }, total: { $sum: "$total" }, pedidos: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          porHora: [
            { $group: { _id: { $hour: { date: "$created_at", timezone: TZ } }, total: { $sum: "$total" } } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]),
    // Periodo anterior (misma duración) para comparativa
    Order.aggregate([
      { $match: paidMatch(prevStart, prevEnd) },
      { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    // Productos: ventas por ítem + costo (rentabilidad)
    Order.aggregate([
      { $match: paidMatch(start, end) },
      { $unwind: "$items" },
      { $group: { _id: "$items.product_id", name: { $first: "$items.name" }, qty: { $sum: "$items.quantity" }, revenue: { $sum: "$items.subtotal" } } },
      { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "p" } },
      { $addFields: { cost: { $ifNull: [{ $arrayElemAt: ["$p.cost_price", 0] }, 0] } } },
      { $project: { name: 1, qty: 1, revenue: 1, costo: { $multiply: ["$cost", "$qty"] }, utilidad: { $subtract: ["$revenue", { $multiply: ["$cost", "$qty"] }] } } },
    ]),
    // Entregados en el rango → tiempos por etapa del pedido
    Order.find({ status: ORDER_STATUS.DELIVERED, delivered_at: mongoose.trusted({ $gte: start, $lte: end }) })
      .select("total created_at delivered_at status_history items").lean(),
    // Cola actual (en vivo)
    Order.aggregate([
      { $match: { status: { $in: ["pending", "paid", "preparing", "ready"] } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
    // Cobros del periodo por método de pago
    Order.aggregate([
      { $match: paidMatch(start, end) },
      { $group: { _id: "$payment.method", total: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    // Quiebres / stock bajo
    Product.find({ is_active: true }).select("name stock reserved allocated").lean(),
    // Compras de mercadería (recepciones × costo) — egreso de inventario del periodo
    StockMovement.aggregate([
      { $match: { type: MOVEMENT_TYPES.RECEIVING, created_at: { $gte: start, $lte: end } } },
      { $lookup: { from: "products", localField: "product_id", foreignField: "_id", as: "p" } },
      { $addFields: { cost: { $ifNull: [{ $arrayElemAt: ["$p.cost_price", 0] }, 0] } } },
      { $group: { _id: null, compras: { $sum: { $multiply: ["$quantity", "$cost"] } }, unidades: { $sum: "$quantity" } } },
    ]),
    // Ingresos por método de pago: pagados del periodo por paid_at (cobro real)
    Order.aggregate([
      { $match: { status: { $in: PAID_STATUSES }, paid_at: { $gte: start, $lte: end } } },
      { $group: { _id: "$payment.method", total: { $sum: "$total" } } },
    ]),
  ]);

  // ── Ventas ──
  const vt = ventasAgg[0] || {};
  const total = r0(vt.totals?.[0]?.total);
  const pedidos = vt.totals?.[0]?.count || 0;
  const serie = (vt.porDia || []).map((d) => ({ dia: d._id, total: r0(d.total), pedidos: d.pedidos }));
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, total: r0((vt.porHora || []).find((x) => x._id === h)?.total) }));
  const prevTotal = r0(prevAgg[0]?.total);
  const ventas = {
    total, pedidos, ticket: pedidos ? r0(total / pedidos) : 0, serie, porHora,
    prev: { total: prevTotal, pedidos: prevAgg[0]?.count || 0 },
    variacionPct: prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null,
  };

  // ── Productos ──
  const prods = prodAgg.map((p) => ({
    product_id: p._id ? String(p._id) : null, // para abrir la ficha técnica desde el panel
    name: p.name, qty: p.qty, revenue: r0(p.revenue), costo: r0(p.costo), utilidad: r0(p.utilidad),
    margenPct: p.revenue > 0 ? Math.round((p.utilidad / p.revenue) * 100) : null,
  }));
  const conCosto = prods.filter((p) => p.costo > 0);
  const productos = {
    top: [...prods].sort((a, b) => b.qty - a.qty).slice(0, 8),
    bottom: [...prods].sort((a, b) => a.qty - b.qty).slice(0, 8),
    margen: [...conCosto].sort((a, b) => b.utilidad - a.utilidad).slice(0, 8),
    utilidadTotal: conCosto.reduce((a, p) => a + p.utilidad, 0),
    margenPromedio: conCosto.length ? Math.round(avg(conCosto.map((p) => p.margenPct))) : null,
    distintos: prods.length,
  };

  // ── Operación (de los entregados) ──
  const D = { espera_pago: [], espera_cola: [], preparacion: [], espera_entrega: [], total: [] };
  const prepPorPersona = {};
  for (const o of deliveredDocs) {
    const created = new Date(o.created_at).getTime();
    const paid = firstTs(o.status_history, "paid");
    const prep = firstTs(o.status_history, "preparing");
    const ready = firstTs(o.status_history, "ready");
    const del = firstTs(o.status_history, "delivered") || new Date(o.delivered_at).getTime();
    const push = (arr, v) => { if (v != null) arr.push(v); };
    push(D.espera_pago, mins(created, paid));
    push(D.espera_cola, mins(paid, prep));
    push(D.preparacion, mins(prep, ready));
    push(D.espera_entrega, mins(ready, del));
    push(D.total, mins(created, del));
    const b = actorOf(o.status_history, "preparing");
    const pm = mins(prep, ready);
    if (b) {
      prepPorPersona[b] = prepPorPersona[b] || { label: b, preparados: 0, _t: [] };
      prepPorPersona[b].preparados++;
      if (pm != null) prepPorPersona[b]._t.push(pm);
    }
  }
  // null cuando no hay nada que medir: "0 min" se lee como un tiempo medido y
  // hacía que el panel declarara "flujo al día" sin un solo pedido entregado.
  // Mismo criterio que dashboard360Controller, que ya lo resolvía así.
  const promedioONull = (arr) => (arr.length ? r0(avg(arr)) : null);
  const tiempos = {
    espera_pago: promedioONull(D.espera_pago), espera_cola: promedioONull(D.espera_cola),
    preparacion: promedioONull(D.preparacion), espera_entrega: promedioONull(D.espera_entrega),
    total: promedioONull(D.total),
  };
  const ETAPAS = { espera_pago: "Espera de pago", espera_cola: "Espera en cola", preparacion: "Preparación", espera_entrega: "Espera de entrega" };
  const cuelloE = Object.entries(ETAPAS)
    .map(([k, l]) => [l, tiempos[k]])
    .filter(([, v]) => v != null)
    .sort((a, b) => b[1] - a[1])[0];
  const cola = { pending: 0, paid: 0, preparing: 0, ready: 0 };
  colaAgg.forEach((x) => { cola[x._id] = x.n; });
  const horas = Math.max(1, durMs / 3600000);
  const operacion = {
    entregados: deliveredDocs.length, cola, en_cola_total: cola.pending + cola.paid + cola.preparing + cola.ready,
    tiempos, cuello: cuelloE && cuelloE[1] > 0 ? { etapa: cuelloE[0], minutos: cuelloE[1] } : null,
    throughput_hora: Math.round((deliveredDocs.length / horas) * 10) / 10,
  };
  const equipo = {
    preparacion: Object.values(prepPorPersona)
      .map((x) => ({ label: x.label, preparados: x.preparados, prep_prom_min: r0(avg(x._t)) }))
      .sort((a, b) => a.prep_prom_min - b.prep_prom_min),
  };

  // ── Cobros por método de pago ──
  const NORM = { cash_on_pickup: "efectivo", transfer: "transferencia", card: "tarjeta" };
  const byMethod = {};
  let cobrosTotal = 0;
  cobrosAgg.forEach((x) => { const k = NORM[x._id] || x._id || "otro"; byMethod[k] = (byMethod[k] || 0) + r0(x.total); cobrosTotal += r0(x.total); });
  const cobros = { total: cobrosTotal, byMethod, count: cobrosAgg.reduce((a, x) => a + x.count, 0) };

  // ── Stock ──
  const disp = (p) => Math.max(0, (p.stock || 0) - (p.reserved || 0) - (p.allocated || 0));
  const quiebre = quiebres.filter((p) => disp(p) <= 0).map((p) => ({ product_id: String(p._id), name: p.name, stock: disp(p) }));
  const bajos = quiebres.filter((p) => disp(p) > 0 && disp(p) <= 10).map((p) => ({ product_id: String(p._id), name: p.name, stock: disp(p) })).sort((a, b) => a.stock - b.stock);
  const inventario = { quiebres: quiebre.slice(0, 20), quiebresCount: quiebre.length, bajos: bajos.slice(0, 20), bajosCount: bajos.length, activos: quiebres.length };

  // ── Finanzas: estado de resultados del periodo (datos reales) ──
  const cogs = prods.reduce((a, p) => a + (p.costo || 0), 0);
  const compras = r0(comprasAgg[0]?.compras);
  // Desglose de ingresos por método sobre lo pagado en el periodo (paid_at).
  const por_metodo = { efectivo: 0, tarjeta: 0, transferencia: 0, webpay: 0 };
  let cobradoReal = 0;
  pagosAgg.forEach((x) => { const k = NORM[x._id] || x._id || "otro"; const v = r0(x.total); por_metodo[k] = (por_metodo[k] || 0) + v; cobradoReal += v; });
  // Utilidad y margen solo cuando la cifra significa algo.
  //
  // Dos trampas que este bloque evita:
  //
  // 1. Sin costo cargado, `cogs` da 0 y la utilidad bruta sería TODA la venta
  //    con 100% de margen: un número creíble y completamente falso.
  // 2. Con UN SOLO producto con costo, la guardia `cogs > 0` se activaba igual y
  //    cargaba TODOS los ingresos del periodo contra el costo de ese único
  //    producto: margen publicado del 95-99%, igual de falso pero más difícil de
  //    detectar. Es lo que iba a pasar apenas empezaran a cargar costos.
  //
  // La comparación correcta enfrenta bases equivalentes: el ingreso de los
  // productos CON costo conocido contra su propio costo. Y se exige una
  // cobertura mínima del periodo para publicarla; por debajo de eso la muestra
  // no representa al negocio y va en null, con el detalle para explicarlo.
  const COBERTURA_MINIMA = 0.8; // 80% del ingreso del periodo con costo conocido
  const conCostoCargado = prods.filter((p) => p.costo > 0).length;
  const ingresoConCosto = prods.reduce((a, p) => a + (p.costo > 0 ? p.revenue : 0), 0);
  const ingresoProductos = prods.reduce((a, p) => a + p.revenue, 0);
  const cobertura = ingresoProductos > 0 ? ingresoConCosto / ingresoProductos : 0;
  const hayCosto = cogs > 0 && cobertura >= COBERTURA_MINIMA;
  const utilidadConCosto = ingresoConCosto - cogs;
  const finanzas = {
    // "Cobrado" salía de cobrosAgg, que usa EXACTAMENTE el mismo filtro que el
    // total de ventas (mismo estado, misma fecha de creación, mismo campo), así
    // que por construcción era una copia de "Ventas" y declaraba cobrado lo que
    // no se había cobrado — una venta a crédito entraba ahí al crearse. Lo real
    // es lo que tiene paid_at dentro del periodo, que es lo que ya calcula
    // pagosAgg para el desglose por método.
    ingresos: { ventas: total, cobrado: cobradoReal, por_metodo },
    egresos: { cogs: hayCosto ? cogs : null, compras },
    utilidadBruta: hayCosto ? r0(utilidadConCosto) : null,
    // Sobre el ingreso de los productos con costo, no sobre `total`, que además
    // incluye el flete: subir la tarifa de despacho "mejoraba el margen" sin
    // haber vendido más.
    margenBrutoPct:
      hayCosto && ingresoConCosto > 0
        ? Math.round((utilidadConCosto / ingresoConCosto) * 100)
        : null,
    sinCosto: prods.filter((p) => !(p.costo > 0)).length,
    conCosto: conCostoCargado,
    // El panel usa esto para explicar por qué no hay cifras en vez de mostrar ceros.
    costosIncompletos: conCostoCargado < prods.length,
    coberturaCostosPct: Math.round(cobertura * 100),
  };

  res.json({ success: true, data: { rango: { from, to }, ventas, operacion, equipo, productos, cobros, inventario, finanzas } });
});

export default { getGerencia };
