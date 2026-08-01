import { asyncHandler } from "../middlewares/errorHandler.js";
import { NotFoundError, ForbiddenError } from "../utils/errors.js";
import { PERMISSIONS, roleHasPermission } from "../utils/constants.js";
import Product from "../models/Product.js";
import { getBoxQty } from "../services/pricingService.js";
import {
  adjustStock,
  receiveStock,
  listMovements,
  listLowStock,
  listReorder,
  listExpiringSoon,
  listBatches,
  listExpiringBatches,
} from "../services/inventoryService.js";
import {
  startCount,
  listCounts,
  getCount,
  updateCountLines,
  closeCount,
  cancelCount,
} from "../services/cycleCountService.js";

// Autor (kardex / created_by / closed_by) a partir del usuario autenticado.
const actorFromReq = (req) => ({
  user_id: req.user?.id || null,
  role: req.user?.role || null,
  label: req.user?.email || "admin",
});

/**
 * GET /api/inventory/movements
 * Kardex paginado. Filtros: product_id, order_id, type, from, to.
 */
export const getMovements = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const { product_id, order_id, type, from, to, page, limit } = req.query;

  const result = await listMovements({
    productId: product_id || undefined,
    orderId: order_id || undefined,
    type: type || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    limit,
  });

  return res.json({ success: true, data: result });
});

/**
 * POST /api/inventory/adjust
 * Ajuste manual de stock con motivo obligatorio (queda en kardex con autor).
 * body: { product_id, delta, reason }
 */
export const postAdjustStock = asyncHandler(async (req, res) => {
  const { product_id, delta, reason } = req.body;

  const product = await adjustStock({
    productId: product_id,
    delta,
    reason,
    by: {
      user_id: req.user?.id || null,
      role: req.user?.role || null,
      label: req.user?.email || "admin",
    },
  });

  return res.json({
    success: true,
    data: {
      product_id: String(product._id),
      name: product.name,
      stock: product.stock,
    },
  });
});

/**
 * POST /api/inventory/receive
 * Recepción de mercadería: ingreso masivo de un cargamento de proveedor.
 * Incrementa stock y registra un movimiento RECEIVING por ítem en una transacción.
 * body: { supplier?, doc_ref?, items: [{ product_id, qty }] }
 */
export const postReceiveStock = asyncHandler(async (req, res) => {
  const { supplier, doc_ref, items, expiry_date } = req.body;

  const { received, total_items } = await receiveStock({
    supplier,
    doc_ref,
    items,
    expiry_date,
    by: {
      user_id: req.user?.id || null,
      role: req.user?.role || null,
      label: req.user?.email || "admin",
    },
  });

  return res.json({ success: true, data: { received, total_items } });
});

/**
 * GET /api/inventory/low-stock?threshold=10
 * Productos con stock crítico, ordenados de menor a mayor (dashboard supervisor).
 */
export const getLowStock = asyncHandler(async (req, res) => {
  const items = await listLowStock({
    threshold: req.query.threshold,
    limit: req.query.limit,
  });
  return res.json({ success: true, data: { items, count: items.length } });
});

/**
 * GET /api/inventory/reorder?limit=200
 * Lista de reposición: productos bajo su punto de reorden (min_stock), con la
 * cantidad sugerida a comprar en unidades y cajas, urgencia y proveedor.
 */
export const getReorderList = asyncHandler(async (req, res) => {
  const items = await listReorder({ limit: req.query.limit });
  return res.json({ success: true, data: { items, count: items.length } });
});

/**
 * GET /api/inventory/expiring-soon?days=30
 * Productos activos con vencimiento dentro de `days` días (incluye ya vencidos),
 * ordenados por expiry_date ascendente. days por defecto 30, rango 1..365.
 */
export const getExpiringSoon = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const items = await listExpiringSoon({ days: req.query.days });
  return res.json({ success: true, data: { items, count: items.length } });
});

/**
 * GET /api/inventory/lotes
 * Lista paginada de lotes (Batch) — trazabilidad e histórico de costos.
 * Filtros: product_id, status (default open; todos/all = sin filtro), q, page.
 */
export const getLotes = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const { product_id, status, q, page, limit } = req.query;
  const result = await listBatches({
    product_id: product_id || undefined,
    status: status || undefined,
    q: q || undefined,
    page,
    limit,
  });

  return res.json({
    success: true,
    data: { items: result.items, count: result.pagination.total, pagination: result.pagination },
  });
});

/**
 * GET /api/inventory/lotes/expiring?days=N
 * Lotes open por vencer dentro de N días (FEFO por lote). Orden expiry asc.
 */
export const getLotesExpiring = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const items = await listExpiringBatches({ days: req.query.days });
  return res.json({ success: true, data: { items, count: items.length } });
});

/**
 * GET /api/inventory/by-barcode/:code
 * Lookup por código de barras — validación de picking por escaneo.
 */
export const getProductByBarcode = asyncHandler(async (req, res) => {
  const code = String(req.params.code || "").trim();
  const product = await Product.findOne({ barcode: code, is_active: true })
    .select("name sku barcode stock location thumbnail pricing.min_price pricing.tiers")
    .lean();

  if (!product) {
    throw new NotFoundError(`No existe producto activo con código ${code}`);
  }

  // box_qty = unidades por caja (mayor min_qty entre los tiers; 1 si solo unidad).
  // La recepción opera en cajas y necesita este factor para traducir a unidades.
  return res.json({ success: true, data: { ...product, box_qty: getBoxQty(product.pricing?.tiers) } });
});

/**
 * GET /inventory/stock-summary?threshold=10
 * Panorama gráfico del inventario: stock por categoría, top productos y totales.
 * `value` usa pricing.min_price (precio de venta más bajo) × stock — proxy de
 * valor de venta del inventario (no es costo; el costeo llega con Inbound/F5).
 */
export const getStockSummary = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const threshold = Math.max(0, Number(req.query.threshold) || 10);

  // Vendemos por CAJA: el panorama se calcula en cajas y unidades. Se hace todo
  // en un único Product.aggregate (en el motor de Mongo) en vez de cargar todos
  // los productos a memoria y agregar en JS. $facet ejecuta en paralelo el
  // agrupado por categoría y el ranking de top productos.
  //
  // boxQty = mayor min_qty entre los tiers (la "caja"); 1 si ninguno > 1.
  // cajas  = floor(stock / boxQty) ; value = stock * pricing.min_price.
  const safeStock = { $ifNull: ["$stock", 0] };
  const boxQtyExpr = {
    $let: {
      vars: {
        maxMin: {
          $max: {
            $map: {
              input: { $ifNull: ["$pricing.tiers", []] },
              as: "t",
              in: { $ifNull: ["$$t.min_qty", 1] },
            },
          },
        },
      },
      in: { $cond: [{ $gt: ["$$maxMin", 1] }, "$$maxMin", 1] },
    },
  };

  const baseFields = {
    $addFields: {
      _units: safeStock,
      _boxQty: boxQtyExpr,
      _value: { $multiply: [safeStock, { $ifNull: ["$pricing.min_price", 0] }] },
    },
  };
  const cajasField = {
    $addFields: { _cajas: { $floor: { $divide: ["$_units", "$_boxQty"] } } },
  };

  const [result] = await Product.aggregate([
    { $match: { is_active: true } },
    baseFields,
    cajasField,
    {
      $facet: {
        by_category: [
          {
            $group: {
              _id: { $ifNull: ["$category.name", "Sin categoría"] },
              sku_count: { $sum: 1 },
              units: { $sum: "$_units" },
              cajas: { $sum: "$_cajas" },
              low: {
                $sum: { $cond: [{ $lte: ["$_units", threshold] }, 1, 0] },
              },
              value: { $sum: "$_value" },
            },
          },
          {
            $project: {
              _id: 0,
              category: "$_id",
              sku_count: 1,
              units: 1,
              cajas: 1,
              low: 1,
              value: { $round: ["$value", 0] },
            },
          },
          { $sort: { cajas: -1 } },
        ],
        top_products: [
          { $sort: { _cajas: -1 } },
          { $limit: 8 },
          {
            $project: {
              _id: 0,
              name: 1,
              stock: "$_units",
              box_qty: "$_boxQty",
              cajas: "$_cajas",
              category: { $ifNull: ["$category.name", "—"] },
              barcode: { $ifNull: ["$barcode", null] },
            },
          },
        ],
      },
    },
  ]);

  const by_category = result?.by_category || [];
  const top_products = result?.top_products || [];

  const totals = by_category.reduce(
    (a, c) => ({
      sku: a.sku + c.sku_count,
      units: a.units + c.units,
      cajas: a.cajas + c.cajas,
      low: a.low + c.low,
      value: a.value + c.value,
    }),
    { sku: 0, units: 0, cajas: 0, low: 0, value: 0 },
  );

  return res.json({
    success: true,
    data: { threshold, totals, by_category, top_products },
  });
});

/**
 * POST /api/inventory/counts
 * Inicia un conteo físico (cycle count). Snapshotea los productos del scope.
 * body: { scope: { type: "category"|"all", value?, label? } }
 */
export const postStartCount = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_ADJUST)) {
    throw new ForbiddenError("No tienes permiso para ajustar inventario");
  }

  const count = await startCount({ scope: req.body?.scope, by: actorFromReq(req) });
  return res.json({ success: true, data: count });
});

/**
 * GET /api/inventory/counts?status=&limit=
 * Lista de conteos (abiertos + recientes cerrados).
 */
export const getCounts = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const items = await listCounts({ status: req.query.status, limit: req.query.limit });
  return res.json({ success: true, data: { items, count: items.length } });
});

/**
 * GET /api/inventory/counts/:id
 * Una sesión de conteo con sus líneas.
 */
export const getCountById = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_READ)) {
    throw new ForbiddenError("No tienes permiso para consultar inventario");
  }

  const count = await getCount(req.params.id);
  return res.json({ success: true, data: count });
});

/**
 * PATCH /api/inventory/counts/:id
 * Registra cantidades contadas (guardado progresivo). Solo sobre conteos open.
 * body: { counts: [{ product_id, counted_qty }] }
 */
export const patchCountLines = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_ADJUST)) {
    throw new ForbiddenError("No tienes permiso para ajustar inventario");
  }

  const count = await updateCountLines({
    id: req.params.id,
    counts: req.body?.counts,
    by: actorFromReq(req),
  });
  return res.json({ success: true, data: count });
});

/**
 * POST /api/inventory/counts/:id/close
 * Cierra el conteo y aplica los ajustes (conteo autoritativo: stock := contado).
 */
export const postCloseCount = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_ADJUST)) {
    throw new ForbiddenError("No tienes permiso para ajustar inventario");
  }

  const count = await closeCount({ id: req.params.id, by: actorFromReq(req) });
  return res.json({ success: true, data: count });
});

/**
 * POST /api/inventory/counts/:id/cancel
 * Cancela el conteo sin aplicar ajustes.
 */
export const postCancelCount = asyncHandler(async (req, res) => {
  if (!roleHasPermission(req.user?.role, PERMISSIONS.INVENTORY_ADJUST)) {
    throw new ForbiddenError("No tienes permiso para ajustar inventario");
  }

  const count = await cancelCount({ id: req.params.id, by: actorFromReq(req) });
  return res.json({ success: true, data: count });
});
