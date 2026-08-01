import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import StockMovement from "../models/StockMovement.js";
import { ORDER_STATUS, PAID_STATUSES, MOVEMENT_TYPES } from "../utils/constants.js";
import { DEFAULT_PILOTO, rankingPiloto } from "../incentivos/piloto.js";
import { premioPorTiempo } from "../incentivos/tiempo.js";

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
  const today = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today;
  const start = new Date(`${from}T00:00:00.000`);
  const end = new Date(`${to}T23:59:59.999`);
  const durMs = Math.max(1, end - start);
  const prevStart = new Date(start.getTime() - durMs);
  const prevEnd = new Date(start.getTime() - 1);
  const paidMatch = (s, e) => ({ status: { $in: PAID_STATUSES }, created_at: { $gte: s, $lte: e } });

  const [ventasAgg, prevAgg, prodAgg, deliveredDocs, colaAgg, cajaAgg, quiebres, comprasAgg, vendAgg, pagosAgg] = await Promise.all([
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
    // Entregados en el rango → tiempos por etapa + desempeño por persona
    Order.find({ status: ORDER_STATUS.DELIVERED, delivered_at: mongoose.trusted({ $gte: start, $lte: end }) })
      .select("total created_at delivered_at status_history items codigo_escaneo seller").lean(),
    // Cola actual (en vivo)
    Order.aggregate([
      { $match: { status: { $in: ["pending", "paid", "preparing", "ready"] } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
    // Caja: efectivo/otros del periodo por método
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
    // Vendedores: atribución de primera clase por Order.seller sobre pagados del
    // periodo (mismo criterio que mis-metricas). Los pedidos web (sin seller.id)
    // quedan fuera del ranking — no crean vendedores fantasma "cliente/invitado".
    Order.aggregate([
      { $match: { ...paidMatch(start, end), "seller.id": { $ne: null } } },
      {
        $group: {
          _id: "$seller.id",
          label: { $first: "$seller.nombre" },
          pedidos: { $sum: 1 },
          monto: { $sum: "$total" },
          unidades: { $sum: { $sum: "$items.quantity" } },
        },
      },
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

  // ── Operación + Equipo (de los entregados) ──
  const D = { espera_cobro: [], espera_cola: [], preparacion: [], espera_retiro: [], total: [] };
  const caje = {}, bode = {};
  for (const o of deliveredDocs) {
    // Solo pedidos de sala (relay) para los tiempos: un pedido web (sin boleta ni
    // vendedor) puede tardar días en pagarse y revienta los promedios.
    const esSala = Boolean(o.codigo_escaneo || o.seller?.id);
    const created = new Date(o.created_at).getTime();
    const paid = firstTs(o.status_history, "paid");
    const prep = firstTs(o.status_history, "preparing");
    const ready = firstTs(o.status_history, "ready");
    const del = firstTs(o.status_history, "delivered") || new Date(o.delivered_at).getTime();
    const push = (arr, v) => { if (esSala && v != null) arr.push(v); };
    const ec = mins(created, paid);
    push(D.espera_cobro, ec);
    push(D.espera_cola, mins(paid, prep));
    push(D.preparacion, mins(prep, ready));
    push(D.espera_retiro, mins(ready, del));
    push(D.total, mins(created, del));
    const c = actorOf(o.status_history, "paid");
    if (c) { caje[c] = caje[c] || { label: c, cobros: 0, monto: 0, _t: [] }; caje[c].cobros++; caje[c].monto += o.total || 0; if (esSala && ec != null) caje[c]._t.push(ec); }
    const b = actorOf(o.status_history, "preparing");
    const pm = mins(prep, ready);
    if (b) {
      bode[b] = bode[b] || { label: b, preparados: 0, _t: [], premio: 0 };
      bode[b].preparados++;
      if (pm != null) bode[b]._t.push(pm);
      // Incentivo por tiempo de preparación (tramos en incentivos/tiempo.js).
      const pr = premioPorTiempo({ total: o.total, n_sku: (o.items || []).length, prep_min: pm });
      if (pr?.premio) bode[b].premio += pr.premio;
    }
  }
  const tiempos = {
    espera_cobro: r0(avg(D.espera_cobro)), espera_cola: r0(avg(D.espera_cola)),
    preparacion: r0(avg(D.preparacion)), espera_retiro: r0(avg(D.espera_retiro)), total: r0(avg(D.total)),
  };
  const ETAPAS = { espera_cobro: "Espera + cobro", espera_cola: "Espera en cola", preparacion: "Preparación", espera_retiro: "Espera de retiro" };
  const cuelloE = Object.entries(ETAPAS).map(([k, l]) => [l, tiempos[k]]).sort((a, b) => b[1] - a[1])[0];
  const cola = { pending: 0, paid: 0, preparing: 0, ready: 0 };
  colaAgg.forEach((x) => { cola[x._id] = x.n; });
  const horas = Math.max(1, durMs / 3600000);
  const operacion = {
    entregados: deliveredDocs.length, cola, en_cola_total: cola.pending + cola.paid + cola.preparing + cola.ready,
    tiempos, cuello: cuelloE && cuelloE[1] > 0 ? { etapa: cuelloE[0], minutos: cuelloE[1] } : null,
    throughput_hora: Math.round((deliveredDocs.length / horas) * 10) / 10,
  };
  const equipo = {
    vendedores: vendAgg
      .map((x) => ({ label: x.label || "Vendedor", pedidos: x.pedidos, monto: r0(x.monto), unidades: x.unidades || 0, ticket: x.pedidos ? r0(x.monto / x.pedidos) : 0 }))
      .sort((a, b) => b.monto - a.monto),
    cajeras: Object.values(caje).map((x) => ({ label: x.label, cobros: x.cobros, monto: r0(x.monto), t_cobro_prom: r0(avg(x._t || [])) })).sort((a, b) => b.monto - a.monto),
    bodegueros: Object.values(bode).map((x) => ({ label: x.label, preparados: x.preparados, prep_prom_min: r0(avg(x._t)), premio_tiempo: r0(x.premio || 0) })).sort((a, b) => a.prep_prom_min - b.prep_prom_min),
  };

  // ── Caja ──
  const NORM = { cash_on_pickup: "efectivo", transfer: "transferencia", card: "tarjeta" };
  const byMethod = {};
  let cajaTotal = 0;
  cajaAgg.forEach((x) => { const k = NORM[x._id] || x._id || "otro"; byMethod[k] = (byMethod[k] || 0) + r0(x.total); cajaTotal += r0(x.total); });
  const caja = { total: cajaTotal, byMethod, count: cajaAgg.reduce((a, x) => a + x.count, 0) };

  // ── Stock ──
  const disp = (p) => Math.max(0, (p.stock || 0) - (p.reserved || 0) - (p.allocated || 0));
  const quiebre = quiebres.filter((p) => disp(p) <= 0).map((p) => ({ product_id: String(p._id), name: p.name, stock: disp(p) }));
  const bajos = quiebres.filter((p) => disp(p) > 0 && disp(p) <= 10).map((p) => ({ product_id: String(p._id), name: p.name, stock: disp(p) })).sort((a, b) => a.stock - b.stock);
  const inventario = { quiebres: quiebre.slice(0, 20), quiebresCount: quiebre.length, bajos: bajos.slice(0, 20), bajosCount: bajos.length, activos: quiebres.length };

  // ── Incentivos piloto (puntos por unidades + plata), trazable desde los pedidos ──
  const incentivos = {
    config: DEFAULT_PILOTO,
    ranking: rankingPiloto(
      equipo.vendedores.map((v) => ({ label: v.label, pedidos: v.pedidos, unidades: v.unidades || 0, monto: v.monto })),
      DEFAULT_PILOTO,
    ),
  };

  // ── Finanzas: estado de resultados del periodo (datos reales) ──
  const cogs = prods.reduce((a, p) => a + (p.costo || 0), 0);
  const compras = r0(comprasAgg[0]?.compras);
  const utilidadBruta = total - cogs;
  // Desglose de ingresos por método sobre lo pagado en el periodo (paid_at).
  const por_metodo = { efectivo: 0, tarjeta: 0, transferencia: 0, webpay: 0 };
  pagosAgg.forEach((x) => { const k = NORM[x._id] || x._id || "otro"; por_metodo[k] = (por_metodo[k] || 0) + r0(x.total); });
  const finanzas = {
    ingresos: { ventas: total, cobrado: cajaTotal, por_metodo },
    egresos: { cogs, compras },
    utilidadBruta,
    margenBrutoPct: total ? Math.round((utilidadBruta / total) * 100) : null,
    sinCosto: prods.filter((p) => !(p.costo > 0)).length,
  };

  res.json({ success: true, data: { rango: { from, to }, ventas, operacion, equipo, productos, caja, inventario, incentivos, finanzas } });
});

export default { getGerencia };
