import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import Order from "../models/Order.js";
import { ORDER_STATUS } from "../utils/constants.js";
import { premioPorTiempo } from "../incentivos/tiempo.js";

// Métricas del relay de sala (§10 tiempos por etapa + §11 personas/rankings),
// derivadas de los timestamps de status_history. No agrega datos nuevos: lee la
// historia que cada transición ya deja (actor + changed_at).

const firstTs = (hist = [], status) => {
  const h = (hist || []).find((x) => x.status === status);
  return h ? new Date(h.changed_at).getTime() : null;
};
const actorOf = (hist = [], status) => {
  const h = (hist || []).find((x) => x.status === status);
  return h?.changed_by?.label || null;
};
const mins = (a, b) => (a != null && b != null && b >= a ? (b - a) / 60000 : null);
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

export const getRelayMetrics = asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : from;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T23:59:59.999`);

  // Cola actual (en vivo): conteo por etapa AHORA.
  const colaAgg = await Order.aggregate([
    { $match: { status: { $in: ["pending", "paid", "preparing", "ready"] } } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const cola = { pending: 0, paid: 0, preparing: 0, ready: 0 };
  colaAgg.forEach((x) => { cola[x._id] = x.n; });

  // Pedidos entregados en el rango → tiempos por etapa + desempeño por persona.
  const delivered = await Order.find({
    status: ORDER_STATUS.DELIVERED,
    delivered_at: mongoose.trusted({ $gte: start, $lte: end }),
  })
    .select("total created_at delivered_at status_history codigo_escaneo seller items")
    .lean();

  // Solo relay de sala: los pedidos web (sin boleta ni vendedor) pueden tardar
  // días entre created→paid y revientan los promedios de tiempos de la sala.
  const sala = delivered.filter((o) => o.codigo_escaneo || o.seller?.id);

  const D = { espera_cobro: [], espera_cola: [], preparacion: [], espera_retiro: [], total: [] };
  const vend = {}, caje = {}, bode = {};
  for (const o of sala) {
    const created = new Date(o.created_at).getTime();
    const paid = firstTs(o.status_history, "paid");
    const prep = firstTs(o.status_history, "preparing");
    const ready = firstTs(o.status_history, "ready");
    const del = firstTs(o.status_history, "delivered") || new Date(o.delivered_at).getTime();
    const push = (arr, v) => { if (v != null) arr.push(v); };
    push(D.espera_cobro, mins(created, paid));
    push(D.espera_cola, mins(paid, prep));
    push(D.preparacion, mins(prep, ready));
    push(D.espera_retiro, mins(ready, del));
    push(D.total, mins(created, del));

    const v = actorOf(o.status_history, "pending");
    if (v) { vend[v] = vend[v] || { label: v, pedidos: 0, monto: 0 }; vend[v].pedidos++; vend[v].monto += o.total || 0; }
    const c = actorOf(o.status_history, "paid");
    if (c) { caje[c] = caje[c] || { label: c, cobros: 0, monto: 0 }; caje[c].cobros++; caje[c].monto += o.total || 0; }
    const b = actorOf(o.status_history, "preparing");
    const pm = mins(prep, ready);
    if (b) {
      bode[b] = bode[b] || { label: b, preparados: 0, _t: [], _premio: 0 };
      bode[b].preparados++;
      if (pm != null) bode[b]._t.push(pm);
      // Incentivo por tiempo: premio del pedido según tramo (total/SKU) y prep_min.
      const pr = premioPorTiempo({ total: o.total || 0, n_sku: (o.items || []).length, prep_min: pm });
      if (pr) bode[b]._premio += pr.premio;
    }
  }

  const tiempos = {
    espera_cobro: Math.round(avg(D.espera_cobro)),
    espera_cola: Math.round(avg(D.espera_cola)),
    preparacion: Math.round(avg(D.preparacion)),
    espera_retiro: Math.round(avg(D.espera_retiro)),
    total: Math.round(avg(D.total)),
  };
  const ETAPAS = {
    espera_cobro: "Espera + cobro",
    espera_cola: "Espera en cola",
    preparacion: "Preparación",
    espera_retiro: "Espera de retiro",
  };
  const cuelloEntry = Object.entries(ETAPAS)
    .map(([k, label]) => [label, tiempos[k]])
    .sort((a, b) => b[1] - a[1])[0];

  res.json({
    success: true,
    data: {
      rango: { from, to },
      cola,
      en_cola_total: cola.pending + cola.paid + cola.preparing + cola.ready,
      entregados: sala.length,
      entregados_web: delivered.length - sala.length,
      tiempos,
      cuello: cuelloEntry && cuelloEntry[1] > 0 ? { etapa: cuelloEntry[0], minutos: cuelloEntry[1] } : null,
      personas: {
        vendedores: Object.values(vend).sort((a, b) => b.monto - a.monto),
        cajeras: Object.values(caje).sort((a, b) => b.monto - a.monto),
        bodegueros: Object.values(bode)
          .map((x) => ({ label: x.label, preparados: x.preparados, prep_prom_min: Math.round(avg(x._t)), premio_tiempo_total: Math.round(x._premio || 0) }))
          .sort((a, b) => a.prep_prom_min - b.prep_prom_min),
      },
    },
  });
});

export default { getRelayMetrics };
