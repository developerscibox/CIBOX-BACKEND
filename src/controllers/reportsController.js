import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import StockMovement from "../models/StockMovement.js";
import CajaSession from "../models/CajaSession.js";
import { PAID_STATUSES, MOVEMENT_TYPES } from "../utils/constants.js";

// Biblioteca de informes (estilo Defontana N1): kardex valorizado, valorización
// de inventario, rotación/cobertura, ranking de ventas, márgenes, libro de
// ventas y cuadres de caja. Todo derivado de datos REALES (Order, Product,
// StockMovement, CajaSession) — lo que no hay viene en 0/[].
// Gate: requirePermission(REPORTS_READ) a nivel de ruta.

const TZ = "America/Santiago"; // agrupaciones por día/mes en hora chilena, no UTC
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const r0 = (n) => Math.round(Number(n) || 0);

// from/to → Dates. Acepta YYYY-MM-DD (día completo) o ISO con offset.
// Sin from: `defaultDays` hacia atrás desde `to`. Sin to: ahora.
const parseRange = (fromQ, toQ, defaultDays = 30) => {
  const to = toQ
    ? DAY_RE.test(toQ) ? new Date(`${toQ}T23:59:59.999`) : new Date(toQ)
    : new Date();
  const from = fromQ
    ? DAY_RE.test(fromQ) ? new Date(`${fromQ}T00:00:00.000`) : new Date(fromQ)
    : new Date(to.getTime() - defaultDays * 86400000);
  return { from, to };
};

// Lookup del costo ACTUAL del producto (cost_price vigente, no histórico).
const lookupCostoActual = [
  { $lookup: { from: "products", localField: "product_id", foreignField: "_id", as: "p" } },
  { $addFields: { _costo: { $ifNull: [{ $arrayElemAt: ["$p.cost_price", 0] }, 0] } } },
];

/**
 * GET /api/reports/kardex-valorizado?from&to&product_id&limit
 * Mayor Auxiliar: movimientos del kardex valorizados al costo actual del
 * producto (proxy de PMP). Filas + totales de entradas/salidas por tipo.
 */
export const kardexValorizado = asyncHandler(async (req, res) => {
  const { from, to } = parseRange(req.query.from, req.query.to, 30);
  const limit = Math.min(500, Number(req.query.limit) || 500);

  const match = { created_at: { $gte: from, $lte: to } };
  if (req.query.product_id) {
    match.product_id = new mongoose.Types.ObjectId(req.query.product_id);
  }

  const [rows, porTipoAgg] = await Promise.all([
    StockMovement.aggregate([
      { $match: match },
      { $sort: { created_at: 1 } },
      { $limit: limit },
      ...lookupCostoActual,
      {
        $project: {
          _id: 0,
          fecha: "$created_at",
          dia: { $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ } },
          product_id: 1,
          producto: { $ifNull: [{ $arrayElemAt: ["$p.name", 0] }, "$product_name"] },
          tipo: "$type",
          cantidad: "$quantity", // signo: + entrada, − salida
          stock_after: 1,
          costo_unit: "$_costo",
          valor: { $round: [{ $multiply: ["$quantity", "$_costo"] }, 0] },
        },
      },
    ]),
    // Totales sobre el rango COMPLETO (no truncado por limit), por tipo.
    StockMovement.aggregate([
      { $match: match },
      ...lookupCostoActual,
      {
        $group: {
          _id: "$type",
          movimientos: { $sum: 1 },
          unidades: { $sum: "$quantity" },
          valor: { $sum: { $multiply: ["$quantity", "$_costo"] } },
          unidades_entrada: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, "$quantity", 0] } },
          unidades_salida: { $sum: { $cond: [{ $lt: ["$quantity", 0] }, { $abs: "$quantity" }, 0] } },
          valor_entrada: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, { $multiply: ["$quantity", "$_costo"] }, 0] } },
          valor_salida: { $sum: { $cond: [{ $lt: ["$quantity", 0] }, { $multiply: [{ $abs: "$quantity" }, "$_costo"] }, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const por_tipo = porTipoAgg.map((t) => ({
    tipo: t._id,
    movimientos: t.movimientos,
    unidades: t.unidades,
    valor: r0(t.valor),
  }));
  const totales = porTipoAgg.reduce(
    (a, t) => ({
      entradas: { unidades: a.entradas.unidades + t.unidades_entrada, valor: a.entradas.valor + r0(t.valor_entrada) },
      salidas: { unidades: a.salidas.unidades + t.unidades_salida, valor: a.salidas.valor + r0(t.valor_salida) },
    }),
    { entradas: { unidades: 0, valor: 0 }, salidas: { unidades: 0, valor: 0 } },
  );
  totales.neto = {
    unidades: totales.entradas.unidades - totales.salidas.unidades,
    valor: totales.entradas.valor - totales.salidas.valor,
  };

  return res.json({
    success: true,
    data: {
      meta: {
        valorizacion: "valorizado a costo actual (PMP)",
        rango: { from: from.toISOString(), to: to.toISOString() },
        product_id: req.query.product_id || null,
        limit,
        truncado: rows.length === limit,
      },
      rows,
      por_tipo,
      totales,
    },
  });
});

/**
 * GET /api/reports/valorizacion
 * Valorización del inventario actual: stock × costo (valor costo) y
 * stock × precio venta mínimo (valor venta), por categoría y por sector.
 */
export const valorizacion = asyncHandler(async (req, res) => {
  const base = {
    $addFields: {
      _units: { $ifNull: ["$stock", 0] },
      _costo: { $ifNull: ["$cost_price", 0] },
      _venta: { $ifNull: ["$pricing.min_price", 0] },
    },
  };
  const vals = {
    $addFields: {
      _vc: { $multiply: ["$_units", "$_costo"] },
      _vv: { $multiply: ["$_units", "$_venta"] },
      _sinCosto: { $cond: [{ $lte: ["$_costo", 0] }, 1, 0] },
    },
  };
  const groupOn = (idExpr) => [
    {
      $group: {
        _id: idExpr,
        skus: { $sum: 1 },
        unidades: { $sum: "$_units" },
        valor_costo: { $sum: "$_vc" },
        valor_venta: { $sum: "$_vv" },
        skus_sin_costo: { $sum: "$_sinCosto" },
      },
    },
    {
      $project: {
        _id: 0,
        grupo: "$_id",
        skus: 1,
        unidades: 1,
        valor_costo: { $round: ["$valor_costo", 0] },
        valor_venta: { $round: ["$valor_venta", 0] },
        skus_sin_costo: 1,
      },
    },
    { $sort: { valor_costo: -1 } },
  ];

  const [result] = await Product.aggregate([
    { $match: { is_active: true } },
    base,
    vals,
    {
      $facet: {
        por_categoria: groupOn({ $ifNull: ["$category.name", "Sin categoría"] }),
        por_sector: groupOn({
          $cond: [{ $eq: [{ $ifNull: ["$location.sector", ""] }, ""] }, "Sin sector", "$location.sector"],
        }),
        totales: [
          {
            $group: {
              _id: null,
              skus: { $sum: 1 },
              unidades: { $sum: "$_units" },
              valor_costo: { $sum: "$_vc" },
              valor_venta: { $sum: "$_vv" },
              skus_sin_costo: { $sum: "$_sinCosto" },
            },
          },
        ],
      },
    },
  ]);

  const t = result?.totales?.[0] || {};
  return res.json({
    success: true,
    data: {
      meta: {
        valorizacion: "stock × costo actual (PMP) y stock × precio de venta mínimo",
        nota: "skus_sin_costo = productos activos con cost_price 0 (subvaloran el total)",
      },
      totales: {
        skus: t.skus || 0,
        unidades: t.unidades || 0,
        valor_costo: r0(t.valor_costo),
        valor_venta: r0(t.valor_venta),
        skus_sin_costo: t.skus_sin_costo || 0,
      },
      por_categoria: result?.por_categoria || [],
      por_sector: result?.por_sector || [],
    },
  });
});

/**
 * GET /api/reports/rotacion?days=30
 * Rotación / cobertura por producto: unidades vendidas del período (kardex,
 * tipo venta), venta promedio diaria, stock actual y cobertura en días.
 * Flags: sobre_stock (>60 días), inmovil (0 ventas y stock>0), quiebre
 * (stock 0 con ventas). Orden: quiebres primero, luego cobertura asc.
 */
export const rotacion = asyncHandler(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000);

  const [ventasAgg, products] = await Promise.all([
    StockMovement.aggregate([
      { $match: { type: MOVEMENT_TYPES.SALE, created_at: { $gte: since }, quantity: { $lt: 0 } } },
      { $group: { _id: "$product_id", vendidas: { $sum: { $abs: "$quantity" } } } },
    ]),
    Product.find({ is_active: true })
      .select("name sku stock category.name location.sector")
      .lean(),
  ]);

  const vendidasMap = new Map(ventasAgg.map((v) => [String(v._id), v.vendidas]));

  const items = products
    .map((p) => {
      const stock = Number(p.stock || 0);
      const vendidas = vendidasMap.get(String(p._id)) || 0;
      if (stock <= 0 && vendidas <= 0) return null; // sin stock ni movimiento: no informa
      const ventaPromDia = vendidas / days;
      const cobertura = vendidas > 0 ? stock / ventaPromDia : null;
      return {
        product_id: String(p._id),
        producto: p.name,
        sku: p.sku || "",
        categoria: p.category?.name || "Sin categoría",
        sector: p.location?.sector || "",
        stock,
        vendidas,
        venta_prom_dia: Math.round(ventaPromDia * 100) / 100,
        cobertura_dias: cobertura != null ? Math.round(cobertura * 10) / 10 : null,
        sobre_stock: cobertura != null && cobertura > 60,
        inmovil: vendidas === 0 && stock > 0,
        quiebre: stock === 0 && vendidas > 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.quiebre !== b.quiebre) return a.quiebre ? -1 : 1;
      const ca = a.cobertura_dias == null ? Infinity : a.cobertura_dias;
      const cb = b.cobertura_dias == null ? Infinity : b.cobertura_dias;
      return ca - cb || b.vendidas - a.vendidas;
    });

  const resumen = {
    productos: items.length,
    quiebres: items.filter((i) => i.quiebre).length,
    sobre_stock: items.filter((i) => i.sobre_stock).length,
    inmoviles: items.filter((i) => i.inmovil).length,
  };

  return res.json({
    success: true,
    data: { meta: { days, desde: since.toISOString() }, resumen, items },
  });
});

/**
 * GET /api/reports/ranking?by=vendedor|producto|cliente&from&to&limit=20
 * Ranking de ventas sobre pedidos pagados (PAID_STATUSES) del rango.
 */
export const ranking = asyncHandler(async (req, res) => {
  const by = req.query.by || "producto";
  const { from, to } = parseRange(req.query.from, req.query.to, 30);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const paidMatch = { status: { $in: PAID_STATUSES }, created_at: { $gte: from, $lte: to } };

  let agg;
  if (by === "vendedor") {
    // Solo pedidos de sala con atribución (seller.id) — los web quedan fuera.
    agg = await Order.aggregate([
      { $match: { ...paidMatch, "seller.id": { $ne: null } } },
      {
        $group: {
          _id: "$seller.id",
          label: { $first: "$seller.nombre" },
          total: { $sum: "$total" },
          pedidos: { $sum: 1 },
          unidades: { $sum: { $sum: "$items.quantity" } },
        },
      },
      { $sort: { total: -1 } },
      { $limit: limit },
    ]);
  } else if (by === "cliente") {
    // Clave: user_id si existe; si no, el nombre del cliente presencial.
    agg = await Order.aggregate([
      { $match: paidMatch },
      { $addFields: { _cli: { $ifNull: ["$user_id", { $ifNull: ["$customer.fullName", "Sin identificar"] }] } } },
      {
        $group: {
          _id: "$_cli",
          label: { $first: { $ifNull: ["$customer.fullName", "Cliente sin nombre"] } },
          total: { $sum: "$total" },
          pedidos: { $sum: 1 },
          unidades: { $sum: { $sum: "$items.quantity" } },
        },
      },
      { $sort: { total: -1 } },
      { $limit: limit },
    ]);
  } else {
    // producto: desagrega las líneas; pedidos = nº de órdenes distintas.
    agg = await Order.aggregate([
      { $match: paidMatch },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product_id",
          label: { $first: "$items.name" },
          total: { $sum: "$items.subtotal" },
          unidades: { $sum: "$items.quantity" },
          pedidosSet: { $addToSet: "$_id" },
        },
      },
      { $addFields: { pedidos: { $size: "$pedidosSet" } } },
      { $project: { pedidosSet: 0 } },
      { $sort: { total: -1 } },
      { $limit: limit },
    ]);
  }

  const items = agg.map((x) => ({
    id: x._id != null ? String(x._id) : null,
    label: x.label || "—",
    total: r0(x.total),
    pedidos: x.pedidos || 0,
    unidades: x.unidades || 0,
    ticket_prom: x.pedidos ? r0(x.total / x.pedidos) : 0,
  }));

  return res.json({
    success: true,
    data: {
      meta: { by, rango: { from: from.toISOString(), to: to.toISOString() }, limit },
      items,
    },
  });
});

/**
 * GET /api/reports/margen?from&to
 * Margen por producto vendido en el rango: venta$ (subtotales), costo$
 * (unidades × cost_price actual), margen$ y margen%.
 */
export const margen = asyncHandler(async (req, res) => {
  const { from, to } = parseRange(req.query.from, req.query.to, 30);

  const agg = await Order.aggregate([
    { $match: { status: { $in: PAID_STATUSES }, created_at: { $gte: from, $lte: to } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product_id",
        producto: { $first: "$items.name" },
        venta: { $sum: "$items.subtotal" },
        unidades: { $sum: "$items.quantity" },
      },
    },
    { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "p" } },
    { $addFields: { costo_unit: { $ifNull: [{ $arrayElemAt: ["$p.cost_price", 0] }, 0] } } },
    {
      $project: {
        producto: 1,
        unidades: 1,
        venta: 1,
        costo_unit: 1,
        costo: { $multiply: ["$unidades", "$costo_unit"] },
        margen: { $subtract: ["$venta", { $multiply: ["$unidades", "$costo_unit"] }] },
      },
    },
    { $sort: { margen: -1 } },
  ]);

  const items = agg.map((x) => ({
    product_id: x._id != null ? String(x._id) : null,
    producto: x.producto,
    unidades: x.unidades,
    venta: r0(x.venta),
    costo_unit: r0(x.costo_unit),
    costo: r0(x.costo),
    margen: r0(x.margen),
    margen_pct: x.venta > 0 ? Math.round((x.margen / x.venta) * 100) : null,
    sin_costo: !(x.costo_unit > 0),
  }));

  const totales = items.reduce(
    (a, i) => ({
      venta: a.venta + i.venta,
      costo: a.costo + i.costo,
      margen: a.margen + i.margen,
      sin_costo: a.sin_costo + (i.sin_costo ? 1 : 0),
    }),
    { venta: 0, costo: 0, margen: 0, sin_costo: 0 },
  );
  totales.margen_pct = totales.venta > 0 ? Math.round((totales.margen / totales.venta) * 100) : null;

  return res.json({
    success: true,
    data: {
      meta: {
        costeo: "costo actual estimado (cost_price vigente, no histórico)",
        rango: { from: from.toISOString(), to: to.toISOString() },
      },
      items,
      totales,
    },
  });
});

/**
 * GET /api/reports/libro-ventas?month=YYYY-MM
 * Libro de ventas interno (pre-SII): pedidos con paid_at dentro del mes en
 * hora chilena. neto = total/1.19 redondeado; iva = total − neto.
 */
export const libroVentas = asyncHandler(async (req, res) => {
  const defaultMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : defaultMonth;

  // Ventana ancha (±1 día) por índice; el corte exacto del mes lo hace
  // $dateToString con timezone Santiago (sin $expr).
  const monthStartUtc = new Date(`${month}-01T00:00:00.000Z`).getTime();
  const approxStart = new Date(monthStartUtc - 86400000);
  const approxEnd = new Date(monthStartUtc + 33 * 86400000);

  const docs = await Order.aggregate([
    { $match: { status: { $in: PAID_STATUSES }, paid_at: { $gte: approxStart, $lte: approxEnd } } },
    { $addFields: { _mes: { $dateToString: { format: "%Y-%m", date: "$paid_at", timezone: TZ } } } },
    { $match: { _mes: month } },
    { $sort: { paid_at: 1 } },
    {
      $project: {
        total: 1,
        paid_at: 1,
        "customer.fullName": 1,
        "customer.rut": 1,
        "payment.method": 1,
        dia: { $dateToString: { format: "%Y-%m-%d", date: "$paid_at", timezone: TZ } },
      },
    },
  ]);

  const rows = docs.map((o) => {
    const total = r0(o.total);
    const neto = Math.round(total / 1.19);
    return {
      order_id: String(o._id),
      folio: String(o._id).slice(-6).toUpperCase(),
      fecha: o.paid_at,
      dia: o.dia,
      cliente: o.customer?.fullName || "Consumidor final",
      rut: o.customer?.rut || null,
      metodo: o.payment?.method || null,
      neto,
      iva: total - neto,
      total,
    };
  });

  const totales = rows.reduce(
    (a, x) => ({ documentos: a.documentos + 1, neto: a.neto + x.neto, iva: a.iva + x.iva, total: a.total + x.total }),
    { documentos: 0, neto: 0, iva: 0, total: 0 },
  );

  return res.json({
    success: true,
    data: {
      meta: {
        month,
        tz: TZ,
        nota: "libro interno pre-SII: neto = total/1.19 redondeado, iva = total − neto (folio = últimos 6 del id)",
      },
      rows,
      totales,
    },
  });
});

/**
 * GET /api/reports/cuadres?limit=30
 * Historial de cuadres de caja: sesiones cerradas, más recientes primero.
 */
export const cuadres = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);

  const sessions = await CajaSession.find({ estado: "cerrada" })
    .sort({ t_cierre: -1 })
    .limit(limit)
    .lean();

  const items = sessions.map((s) => {
    const diferencia = r0(s.diferencia);
    return {
      id: String(s._id),
      fecha: s.t_cierre,
      apertura: s.created_at,
      cajera: s.cajera_label || "—",
      monto_inicial: r0(s.monto_inicial),
      ventas_efectivo: r0(s.ventas_efectivo),
      esperado: r0(s.monto_esperado),
      contado: s.monto_contado != null ? r0(s.monto_contado) : null,
      diferencia,
      estado: diferencia === 0 ? "cuadrada" : diferencia > 0 ? "sobrante" : "faltante",
    };
  });

  const resumen = items.reduce(
    (a, i) => ({
      sesiones: a.sesiones + 1,
      cuadradas: a.cuadradas + (i.estado === "cuadrada" ? 1 : 0),
      sobrantes: a.sobrantes + (i.estado === "sobrante" ? 1 : 0),
      faltantes: a.faltantes + (i.estado === "faltante" ? 1 : 0),
      diferencia_total: a.diferencia_total + i.diferencia,
    }),
    { sesiones: 0, cuadradas: 0, sobrantes: 0, faltantes: 0, diferencia_total: 0 },
  );

  return res.json({ success: true, data: { items, resumen } });
});
