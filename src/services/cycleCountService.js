import mongoose from "mongoose";
import CycleCount from "../models/CycleCount.js";
import Product from "../models/Product.js";
import { adjustStock } from "./inventoryService.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Resuelve el filtro de Product para un scope de conteo.

 *  - category → productos activos cuya categoría (primaria o multi-cat) es value
 *  - all      → todos los productos activos
 * NO usa $expr (rompe sanitizeFilter); $or normal está permitido.
 */
const scopeFilter = (scope) => {
  const type = String(scope?.type || "").trim();
  const value = String(scope?.value ?? "").trim();

  if (type === "category") {
    if (!value) throw new BadRequestError("La categoría del conteo es obligatoria");
    return { is_active: true, $or: [{ "category.id": value }, { category_ids: value }] };
  }
  if (type === "all") {
    return { is_active: true };
  }
  throw new BadRequestError("scope.type inválido (category | all)");
};

const labelForScope = (scope) => {
  const type = String(scope?.type || "").trim();
  if (type === "all") return "Todo el inventario";
  const label = String(scope?.label || "").trim();
  if (label) return label;
  const value = String(scope?.value ?? "").trim();
  return `Categoría ${value}`;
};

const normalizeBy = (by) => ({
  user_id: by?.user_id || null,
  role: by?.role || null,
  label: by?.label || "sistema",
});

/**
 * Inicia un conteo: snapshotea los productos del scope como líneas (con
 * theoretical_qty = stock actual, counted_qty = null). Rechaza si ya hay un
 * conteo `open` con el MISMO scope (un conteo activo por scope).
 */
export const startCount = async ({ scope, by }) => {
  const type = String(scope?.type || "").trim();
  const value = type === "all" ? "" : String(scope?.value ?? "").trim();
  const filter = scopeFilter(scope);

  // Un solo conteo abierto por scope (type + value).
  const dup = await CycleCount.findOne({
    status: "open",
    "scope.type": type,
    "scope.value": value,
  }).lean();
  if (dup) {
    throw new ConflictError("Ya existe un conteo abierto para este alcance");
  }

  const products = await Product.find(filter)
    .select("name sku barcode stock")
    .sort({ name: 1 })
    .lean();

  const lines = products.map((p) => ({
    product_id: p._id,
    product_name: p.name || "",
    sku: p.sku || "",
    barcode: p.barcode || "",
    theoretical_qty: Number(p.stock || 0),
    counted_qty: null,
    counted: false,
  }));

  const count = await CycleCount.create({
    scope: { type, value, label: labelForScope(scope) },
    status: "open",
    lines,
    created_by: normalizeBy(by),
  });

  logger.info(
    { id: String(count._id), scope: { type, value }, lines: lines.length, by: by?.label },
    "conteo físico: sesión iniciada",
  );

  return count;
};

/**
 * Lista de conteos (abiertos + recientes cerrados). status opcional filtra.
 */
export const listCounts = async ({ status, limit } = {}) => {
  const filter = {};
  const st = String(status || "").trim().toLowerCase();
  if (st && st !== "todos" && st !== "all") filter.status = st;

  const cap = Math.min(100, Math.max(1, Number(limit) || 50));

  return CycleCount.find(filter)
    .sort({ status: 1, created_at: -1 })
    .limit(cap)
    .lean();
};

/**
 * Una sesión con sus líneas.
 */
export const getCount = async (id) => {
  const count = await CycleCount.findById(id).lean();
  if (!count) throw new NotFoundError("Conteo no encontrado");
  return count;
};

/**
 * Registra cantidades contadas. counts = [{ product_id, counted_qty }].
 * Setea counted_qty/counted en las líneas correspondientes. Solo sobre `open`.
 */
export const updateCountLines = async ({ id, counts, by }) => {
  if (!Array.isArray(counts) || counts.length === 0) {
    throw new BadRequestError("counts debe ser un arreglo no vacío");
  }

  const count = await CycleCount.findById(id);
  if (!count) throw new NotFoundError("Conteo no encontrado");
  if (count.status !== "open") {
    throw new ConflictError("El conteo no está abierto");
  }

  // Mapa product_id → counted_qty (validado).
  const byProduct = new Map();
  for (const c of counts) {
    const pid = String(c?.product_id || "").trim();
    if (!pid) continue;
    const qty = Number(c?.counted_qty);
    if (!Number.isInteger(qty) || qty < 0) {
      throw new BadRequestError("counted_qty debe ser un entero >= 0");
    }
    byProduct.set(pid, qty);
  }

  // Stock que el sistema tiene AHORA para las líneas que se están contando: es
  // la referencia contra la que se medirá la discrepancia al cerrar. Sin esto,
  // el cierre comparaba contra el stock del momento del cierre y revertía todo
  // lo despachado mientras se contaba.
  const idsContados = [...byProduct.keys()].map((s) => new mongoose.Types.ObjectId(s));
  const stockActual = new Map(
    (await Product.find({ _id: mongoose.trusted({ $in: idsContados }) })
      .select("stock")
      .lean()).map((p) => [String(p._id), Number(p.stock || 0)]),
  );

  const ahora = new Date();
  let touched = 0;
  for (const line of count.lines) {
    const qty = byProduct.get(String(line.product_id));
    if (qty === undefined) continue;
    line.counted_qty = qty;
    line.counted = true;
    line.stock_at_count = stockActual.get(String(line.product_id)) ?? null;
    line.counted_at = ahora;
    touched += 1;
  }

  if (touched === 0) {
    throw new BadRequestError("Ningún product_id coincide con el conteo");
  }

  await count.save();
  logger.info(
    { id: String(count._id), touched, by: by?.label },
    "conteo físico: cantidades registradas",
  );
  return count;
};

/**
 * Cierra el conteo y APLICA los ajustes (conteo autoritativo).
 * Para cada línea contada cuyo counted_qty != stock ACTUAL: adjustStock con
 * delta = counted_qty - stock_actual. El delta se calcula releyendo Product al
 * cerrar (no el snapshot) para que el conteo mande aunque haya habido
 * movimiento. delta 0 se salta. Best-effort por línea (try/catch): si un
 * adjustStock falla (concurrencia, etc.) se loguea y se sigue con los demás.
 */
export const closeCount = async ({ id, by }) => {
  const count = await CycleCount.findById(id);
  if (!count) throw new NotFoundError("Conteo no encontrado");
  if (count.status !== "open") {
    throw new ConflictError("El conteo no está abierto");
  }

  let linesAdjusted = 0;
  let unitsDelta = 0;

  for (const line of count.lines) {
    if (!line.counted || line.counted_qty == null) continue;

    // Stock ACTUAL al cerrar (no el snapshot): el conteo es autoritativo.
    const product = await Product.findById(line.product_id).select("stock").lean();
    if (!product) {
      logger.warn(
        { id: String(count._id), product_id: String(line.product_id) },
        "conteo físico: producto inexistente al cerrar (línea ignorada)",
      );
      continue;
    }

    const current = Number(product.stock || 0);

    // Se aplica la DISCREPANCIA detectada al contar, no se fuerza el stock al
    // valor contado.
    //
    // ANTES: delta = contado − stock_al_cerrar. Si el equipo contaba a las 9 y
    // cerraba a las 13, todo lo despachado en el medio se revertía y volvía al
    // stock: la herramienta que existe para cuadrar el inventario lo
    // descuadraba. Ahora se compara contra el stock del INSTANTE del conteo, así
    // que las ventas posteriores quedan intactas y solo se corrige la diferencia
    // real que encontró la persona en el estante.
    const referencia = line.stock_at_count == null ? current : Number(line.stock_at_count);
    const delta = Number(line.counted_qty) - referencia;
    if (delta === 0) continue; // ya coincide, nada que ajustar

    try {
      await adjustStock({
        productId: line.product_id,
        delta,
        reason: `Conteo físico #${id}`,
        by,
      });
      linesAdjusted += 1;
      unitsDelta += delta;
    } catch (err) {
      logger.warn(
        { id: String(count._id), product_id: String(line.product_id), delta, err: err?.message },
        "conteo físico: ajuste de línea falló (best-effort, ignorado)",
      );
    }
  }

  count.status = "closed";
  count.closed_by = normalizeBy(by);
  count.closed_at = new Date();
  count.applied = { lines_adjusted: linesAdjusted, units_delta: unitsDelta };
  await count.save();

  logger.info(
    { id: String(count._id), lines_adjusted: linesAdjusted, units_delta: unitsDelta, by: by?.label },
    "conteo físico: cerrado y ajustes aplicados",
  );

  return count;
};

/**
 * Cancela el conteo sin aplicar ajustes. Solo sobre `open`.
 */
export const cancelCount = async ({ id, by }) => {
  const count = await CycleCount.findById(id);
  if (!count) throw new NotFoundError("Conteo no encontrado");
  if (count.status !== "open") {
    throw new ConflictError("El conteo no está abierto");
  }

  count.status = "cancelled";
  count.closed_by = normalizeBy(by);
  count.closed_at = new Date();
  await count.save();

  logger.info(
    { id: String(count._id), by: by?.label },
    "conteo físico: cancelado",
  );

  return count;
};
