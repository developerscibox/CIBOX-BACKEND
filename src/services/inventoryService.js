import mongoose from "mongoose";
import Product from "../models/Product.js";
import StockMovement from "../models/StockMovement.js";
import Batch from "../models/Batch.js";
import { MOVEMENT_TYPES } from "../utils/constants.js";
import { getBoxQty } from "./pricingService.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Normaliza un valor de fecha de vencimiento recibido en la recepción.
 * - undefined → undefined (no se especificó: no tocar el campo del producto).
 * - null      → null (limpiar el vencimiento).
 * - string/Date válida → Date.
 * Lanza BadRequestError si el valor es una fecha inválida.
 */
const parseExpiryDate = (value, label = "expiry_date") => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError(`${label} inválida`);
  }
  return d;
};

/**
 * Registra un movimiento de inventario (kardex).
 * Debe ejecutarse dentro de la MISMA sesión/transacción que el cambio de stock
 * para garantizar que kardex y stock nunca queden desincronizados.
 */
export const logMovement = async (
  { productId, productName = "", orderId = null, type, quantity, stockAfter = null, reason = null, by = null },
  session
) => {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty === 0) {
    throw new BadRequestError("Cantidad de movimiento inválida");
  }
  if (!Object.values(MOVEMENT_TYPES).includes(type)) {
    throw new BadRequestError(`Tipo de movimiento inválido: ${type}`);
  }

  const [movement] = await StockMovement.create(
    [
      {
        product_id: productId,
        product_name: productName,
        order_id: orderId,
        type,
        quantity: qty,
        stock_after: stockAfter,
        reason,
        by: {
          user_id: by?.user_id || null,
          role: by?.role || null,
          label: by?.label || "sistema",
        },
      },
    ],
    { session }
  );

  return movement;
};

/**
 * Registra los movimientos de TODOS los items de una orden (una fila por item).
 * sign: -1 para descuento (venta), +1 para reposición (anulación/expiración/reembolso).
 * stockAfterMap: Map<productIdString, stockDespuésDelMovimiento> (opcional).
 */
export const logOrderStockMovements = async (
  { order, type, sign, reason = null, by = null, stockAfterMap = null },
  session
) => {
  if (!order || !Array.isArray(order.items)) return;

  for (const item of order.items) {
    if (!item.product_id) continue;
    const qty = Number(item.quantity || 0);
    if (qty <= 0) continue;

    await logMovement(
      {
        productId: item.product_id,
        productName: item.name || "",
        orderId: order._id,
        type,
        quantity: sign * qty,
        stockAfter: stockAfterMap?.get(String(item.product_id)) ?? null,
        reason,
        by,
      },
      session
    );
  }
};

/**
 * Consume lotes de un producto por FEFO (First Expired, First Out) — BEST-EFFORT.
 * Toma los batches `open` del producto ordenados por expiry_date asc (nulls al
 * final, vía received_at asc como desempate), y descuenta `qty_remaining` hasta
 * cubrir `quantity`. Los batches que llegan a 0 quedan `depleted`.
 *
 * Invariante de seguridad: si los lotes NO cubren la cantidad (productos legacy
 * con stock pero sin lotes), consume lo que haya y devuelve lo consumido. NUNCA
 * lanza: la salida de stock no debe fallar por la capa de lotes.
 *
 * Devuelve [{ batch_id, lot_code, qty }] con lo efectivamente consumido.
 */
export const consumeBatchesFEFO = async ({ productId, quantity }, session) => {
  const need = Number(quantity);
  if (!productId || !Number.isFinite(need) || need <= 0) return [];

  // Orden FEFO: por expiry_date asc. Mongo ordena null/missing PRIMERO en asc,
  // pero FEFO quiere los nulos al FINAL → se separan en dos consultas.
  const q = (filter) => {
    let cur = Batch.find({ product_id: productId, status: "open", ...filter });
    if (session) cur = cur.session(session);
    return cur.sort({ expiry_date: 1, received_at: 1 });
  };

  // 1) lotes con vencimiento (más próximos primero), 2) lotes sin vencimiento.
  const dated = await q({ expiry_date: mongoose.trusted({ $ne: null }) });
  const undated = await q({ expiry_date: null });
  const batches = [...dated, ...undated];

  const consumed = [];
  let remaining = need;
  for (const b of batches) {
    if (remaining <= 0) break;
    const avail = Number(b.qty_remaining || 0);
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    b.qty_remaining = avail - take; // el hook pre-validate marca depleted en 0
    await b.save({ session });
    consumed.push({ batch_id: b._id, lot_code: b.lot_code || "", qty: take });
    remaining -= take;
  }

  return consumed;
};

/**
 * Recalcula Product.expiry_date = menor expiry_date entre los batches `open` del
 * producto (o null si ninguno tiene fecha / no hay lotes open). Mantiene el
 * FEFO-lite producto-nivel y los dashboards coherentes con los lotes.
 */
export const recomputeProductExpiry = async (productId, session) => {
  if (!productId) return;
  let cur = Batch.findOne({
    product_id: productId,
    status: "open",
    expiry_date: mongoose.trusted({ $ne: null }),
  })
    .sort({ expiry_date: 1 })
    .select("expiry_date");
  if (session) cur = cur.session(session);
  const earliest = await cur.lean();

  let upd = Product.updateOne(
    { _id: productId },
    { $set: { expiry_date: earliest?.expiry_date || null } },
  );
  if (session) upd = upd.session(session);
  await upd;
};

/**
 * Lista paginada de lotes con filtros (pantalla Lotes / histórico de costos).
 * Filtros: product_id, status (default "open"; "todos"|"all" = sin filtro), q
 * (busca en product_name o lot_code). Orden por expiry asc (nulls al final).
 */
export const listBatches = async ({ product_id, status = "open", q, page = 1, limit = 50 } = {}) => {
  const filter = {};
  if (product_id) filter.product_id = product_id;
  const st = String(status || "").trim().toLowerCase();
  if (st && st !== "todos" && st !== "all") filter.status = st;
  if (String(q || "").trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ product_name: rx }, { lot_code: rx }];
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    Batch.find(filter)
      .sort({ expiry_date: 1, received_at: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    Batch.countDocuments(filter),
  ]);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    },
  };
};

/**
 * Lotes `open` por vencer dentro de `days` días (incluye ya vencidos), orden
 * expiry asc — FEFO por lote para la pantalla de despacho. Cada fila trae
 * days_left (entero; negativo si ya venció), qty_remaining, lote y ubicación.
 */
export const listExpiringBatches = async ({ days = 60 } = {}) => {
  const d = Math.min(365, Math.max(1, Number(days) || 60));

  const now = new Date();
  const limitDate = new Date(now);
  limitDate.setDate(limitDate.getDate() + d);

  const batches = await Batch.find({
    status: "open",
    expiry_date: mongoose.trusted({ $ne: null, $lte: limitDate }),
  })
    .sort({ expiry_date: 1 })
    .lean();

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  return batches.map((b) => {
    const exp = new Date(b.expiry_date);
    const startOfExp = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate()).getTime();
    return {
      _id: String(b._id),
      product_id: String(b.product_id),
      product_name: b.product_name || "",
      lot_code: b.lot_code || "",
      qty_remaining: b.qty_remaining,
      unit_cost: b.unit_cost || 0,
      expiry_date: b.expiry_date,
      location: b.location || {},
      days_left: Math.round((startOfExp - startOfToday) / MS_PER_DAY),
    };
  });
};

/**
 * Ajuste manual de stock (conteo físico, merma, corrección).
 * Atómico: para deltas negativos exige stock suficiente.
 * Siempre deja huella en el kardex con motivo y autor.
 */
export const adjustStock = async ({ productId, delta, reason, by }) => {
  const qty = Number(delta);
  if (!Number.isInteger(qty) || qty === 0) {
    throw new BadRequestError("delta debe ser un entero distinto de 0");
  }
  if (!String(reason || "").trim()) {
    throw new BadRequestError("El motivo del ajuste es obligatorio");
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const filter = { _id: productId };
      if (qty < 0) filter.stock = mongoose.trusted({ $gte: -qty });

      const updated = await Product.findOneAndUpdate(
        filter,
        { $inc: { stock: qty } },
        { new: true, session }
      );

      if (!updated) {
        const product = await Product.findById(productId).session(session).lean();
        if (!product) throw new NotFoundError("Producto no encontrado");
        throw new ConflictError(
          `Stock insuficiente para ajustar (disponible: ${product.stock}, ajuste: ${qty})`
        );
      }

      await logMovement(
        {
          productId: updated._id,
          productName: updated.name,
          type: qty > 0 ? MOVEMENT_TYPES.RECEIVING : MOVEMENT_TYPES.ADJUSTMENT,
          quantity: qty,
          stockAfter: updated.stock,
          reason: String(reason).trim(),
          by,
        },
        session
      );

      // Merma (delta<0): la salida sale del lote más próximo a vencer (FEFO),
      // best-effort. Conteo a favor (delta>0): NO se crea lote (corrección de
      // lote desconocido). El consumo de lotes nunca debe romper el ajuste.
      if (qty < 0) {
        try {
          await consumeBatchesFEFO({ productId: updated._id, quantity: -qty }, session);
          await recomputeProductExpiry(updated._id, session);
        } catch (err) {
          logger.warn(
            { productId: String(updated._id), err: err?.message },
            "inventario: consumo FEFO de lotes en merma falló (best-effort, ignorado)",
          );
        }
      }

      result = updated;
    });
    logger.info(
      { productId: String(productId), delta: qty, by: by?.label },
      "inventario: ajuste manual aplicado"
    );
    return result;
  } finally {
    await session.endSession();
  }
};

/**
 * Recepción de mercadería: ingreso masivo de un cargamento (entrada de proveedor).
 * En UNA sola transacción incrementa el stock de cada ítem y deja un movimiento
 * RECEIVING en el kardex con el motivo (proveedor / factura) y el autor.
 * Si cualquier ítem falla (producto inexistente), toda la recepción se revierte.
 */
export const receiveStock = async ({ supplier, doc_ref, items, expiry_date, by }) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("La recepción no tiene ítems");
  }

  // Vencimiento a nivel cabecera (aplica a todos los ítems que no traigan el suyo).
  const headerExpiry = parseExpiryDate(expiry_date, "expiry_date");

  // Motivo común que queda en el kardex de cada movimiento.
  const parts = ["Recepción"];
  if (String(supplier || "").trim()) parts.push(`Proveedor ${String(supplier).trim()}`);
  if (String(doc_ref || "").trim()) parts.push(`Doc ${String(doc_ref).trim()}`);
  const reason = parts.join(" · ");

  // Prefijo de fecha para autogenerar lot_code cuando la línea no trae uno:
  // R{YYMMDD}-{n} (n = índice de línea + 1 dentro de esta recepción).
  const now = new Date();
  const yymmdd =
    String(now.getFullYear()).slice(-2) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const session = await mongoose.startSession();
  try {
    let received = [];
    await session.withTransaction(async () => {
      received = [];
      let lineIdx = 0;
      for (const item of items) {
        lineIdx += 1;
        // qty del API = CAJAS recibidas (Cibox opera por caja). Se traduce a
        // unidades con el tamaño de caja del producto, igual que la venta manual.
        const cajas = Number(item.qty);
        if (!Number.isInteger(cajas) || cajas <= 0) {
          throw new BadRequestError("Cada ítem debe tener qty (cajas) entero > 0");
        }

        // Necesitamos los tiers para saber cuántas unidades trae cada caja.
        const product = await Product.findById(item.product_id).session(session);
        if (!product) {
          throw new NotFoundError(`Producto no encontrado: ${item.product_id}`);
        }
        const boxQty = getBoxQty(product.pricing?.tiers); // unidades por caja (≥ 1)
        const units = cajas * boxQty;

        // Vencimiento: el del ítem tiene prioridad sobre el de cabecera.
        const itemExpiry =
          item.expiry_date !== undefined
            ? parseExpiryDate(item.expiry_date, "expiry_date del ítem")
            : headerExpiry;

        const update = { $inc: { stock: units } };
        const set = {};
        if (itemExpiry !== undefined) set.expiry_date = itemExpiry;
        // Putaway: ubicación física asignada al recibir (zona/rack/nivel/código).
        if (item.location && typeof item.location === "object") {
          for (const k of ["zone", "rack", "level", "code"]) {
            if (item.location[k] != null) set[`location.${k}`] = String(item.location[k]).trim();
          }
        }
        // Seguimiento de costo: si la recepción trae costo unitario, se recalcula el
        // costo del producto con PROMEDIO PONDERADO (stock viejo × costo viejo +
        // unidades nuevas × costo nuevo) / total. Así el costo se sigue al comprar.
        if (item.unit_cost != null && Number(item.unit_cost) >= 0) {
          const uc = Number(item.unit_cost);
          const oldStock = Math.max(0, product.stock || 0);
          const oldCost = Number(product.cost_price || 0);
          set.cost_price = oldStock > 0 && oldCost > 0
            ? Math.round((oldStock * oldCost + units * uc) / (oldStock + units))
            : Math.round(uc);
        }
        if (Object.keys(set).length) update.$set = set;

        const updated = await Product.findOneAndUpdate(
          { _id: item.product_id },
          update,
          { new: true, session },
        );

        // El kardex SIEMPRE en unidades (coherente con venta/ajuste). El motivo
        // anota las cajas recibidas cuando la caja trae más de 1 unidad.
        const itemReason = boxQty > 1 ? `${reason} · ${cajas} caja(s) × ${boxQty} un` : reason;
        await logMovement(
          {
            productId: updated._id,
            productName: updated.name,
            type: MOVEMENT_TYPES.RECEIVING,
            quantity: units,
            stockAfter: updated.stock,
            reason: itemReason,
            by,
          },
          session,
        );

        // Lote (capa aditiva): un Batch por línea recibida, EN LA MISMA TXN
        // (la recepción es una ENTRADA atómica; si el lote falla, la txn revierte).
        // lot_code: el del proveedor (item.lot_code) o autogenerado R{YYMMDD}-{n}.
        const lotCode =
          String(item.lot_code || "").trim() || `R${yymmdd}-${lineIdx}`;
        // unit_cost del LOTE = costo de compra de ESTA línea (histórico por lote,
        // independiente del promedio ponderado del producto).
        const lineUnitCost =
          item.unit_cost != null && Number(item.unit_cost) >= 0
            ? Number(item.unit_cost)
            : 0;
        const batchLocation = {
          zone: String(item.location?.zone ?? updated.location?.zone ?? "").trim(),
          rack: String(item.location?.rack ?? updated.location?.rack ?? "").trim(),
          level: String(item.location?.level ?? updated.location?.level ?? "").trim(),
          code: String(item.location?.code ?? updated.location?.code ?? "").trim(),
        };
        await Batch.create(
          [
            {
              product_id: updated._id,
              product_name: updated.name,
              lot_code: lotCode,
              qty_received: units,
              qty_remaining: units,
              unit_cost: lineUnitCost,
              expiry_date: itemExpiry !== undefined ? itemExpiry : null,
              location: batchLocation,
              supplier: String(supplier || "").trim(),
              doc_ref: String(doc_ref || "").trim(),
              status: "open",
              received_at: new Date(),
              received_by: by,
            },
          ],
          { session },
        );

        // Mantener Product.expiry_date = menor expiry de lotes open del producto.
        await recomputeProductExpiry(updated._id, session);

        received.push({
          product_id: String(updated._id),
          name: updated.name,
          cajas,
          box_qty: boxQty,
          units,
          qty: units, // compat: lo ingresado al stock, en unidades
          lot_code: lotCode,
          stock_after: updated.stock,
        });
      }
    });

    logger.info(
      { items: received.length, supplier: supplier || null, doc_ref: doc_ref || null, by: by?.label },
      "inventario: recepción de mercadería registrada",
    );

    return { received, total_items: received.length };
  } finally {
    await session.endSession();
  }
};

/**
 * Consulta paginada del kardex con filtros.
 */
export const listMovements = async ({
  productId,
  orderId,
  type,
  from,
  to,
  page = 1,
  limit = 50,
}) => {
  const filter = {};
  if (productId) filter.product_id = productId;
  if (orderId) filter.order_id = orderId;
  if (type) filter.type = type;
  if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    filter.created_at = mongoose.trusted(range);
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    StockMovement.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    StockMovement.countDocuments(filter),
  ]);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    },
  };
};

/**
 * Productos ACTIVOS con vencimiento dentro de `days` días (incluye los ya
 * vencidos). Ordenados por expiry_date ascendente (lo más urgente primero).
 * days_left = días enteros hasta el vencimiento (negativo si ya venció).
 */
export const listExpiringSoon = async ({ days = 30 } = {}) => {
  const d = Math.min(365, Math.max(1, Number(days) || 30));

  const now = new Date();
  // Límite superior: fin del día número `d` desde hoy.
  const limitDate = new Date(now);
  limitDate.setDate(limitDate.getDate() + d);

  const products = await Product.find({
    is_active: true,
    expiry_date: mongoose.trusted({ $ne: null, $lte: limitDate }),
  })
    .sort({ expiry_date: 1 })
    .select("name stock expiry_date")
    .lean();

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  const items = products.map((p) => {
    const exp = new Date(p.expiry_date);
    const startOfExp = new Date(
      exp.getFullYear(),
      exp.getMonth(),
      exp.getDate(),
    ).getTime();
    const days_left = Math.round((startOfExp - startOfToday) / MS_PER_DAY);
    return {
      _id: String(p._id),
      name: p.name,
      stock: p.stock,
      expiry_date: p.expiry_date,
      days_left,
    };
  });

  return items;
};

/**
 * Lista de reposición: productos ACTIVOS bajo su punto de reorden (min_stock).
 * Regla por producto:
 *   - bajo mínimo  ⇔ min_stock > 0 && stock <= min_stock
 *   - objetivo     = target_stock > 0 ? target_stock : 2 * min_stock
 *   - suggested_qty (unidades) = max(0, objetivo - stock)
 *   - box_qty      = unidades por caja (mayor min_qty entre tiers, ≥ 1)
 *   - suggested_boxes = ceil(suggested_qty / box_qty)
 *   - urgency = "critico" si stock<=0; "alto" si stock/min_stock<=0.5; si no "medio"
 * Orden: stock===0 primero, luego ratio (stock/min_stock) ascendente.
 * NO se usa $expr (rompe con sanitizeFilter): el filtro stock<=min_stock se
 * resuelve en JS sobre el conjunto acotado por min_stock>0.
 */
export const listReorder = async ({ limit } = {}) => {
  const cap = Math.min(500, Math.max(1, Number(limit) || 200));

  const products = await Product.find({
    is_active: true,
    min_stock: mongoose.trusted({ $gt: 0 }),
  })
    .select("name sku barcode stock min_stock target_stock pricing.tiers vendor location")
    .lean();

  const items = products
    .filter((p) => Number(p.stock || 0) <= Number(p.min_stock))
    .map((p) => {
      const stock = Number(p.stock || 0);
      const minStock = Number(p.min_stock);
      const target = Number(p.target_stock) > 0 ? Number(p.target_stock) : 2 * minStock;
      const suggested_qty = Math.max(0, target - stock);
      const box_qty = getBoxQty(p.pricing?.tiers); // unidades por caja (≥ 1)
      const suggested_boxes = Math.ceil(suggested_qty / box_qty);
      const ratio = minStock > 0 ? stock / minStock : 0;
      const urgency = stock <= 0 ? "critico" : ratio <= 0.5 ? "alto" : "medio";

      return {
        _id: String(p._id),
        name: p.name,
        sku: p.sku || "",
        barcode: p.barcode || "",
        stock,
        min_stock: minStock,
        target_stock: Number(p.target_stock || 0),
        suggested_qty,
        box_qty,
        suggested_boxes,
        urgency,
        vendor: { id: p.vendor?.id || null, name: p.vendor?.name || "" },
        location: p.location || {},
        _ratio: ratio,
      };
    })
    .sort((a, b) => {
      // stock 0 primero; luego ratio (stock/min_stock) ascendente.
      const aZero = a.stock === 0 ? 0 : 1;
      const bZero = b.stock === 0 ? 0 : 1;
      if (aZero !== bZero) return aZero - bZero;
      return a._ratio - b._ratio;
    })
    .slice(0, cap);

  // _ratio es auxiliar de orden, no se expone en el contrato.
  for (const it of items) delete it._ratio;

  return items;
};

/**
 * Productos con stock crítico (para el dashboard del supervisor).
 */
export const listLowStock = async ({ threshold = 10, limit = 100 } = {}) => {
  const t = Math.max(0, Number(threshold) || 10);
  return Product.find({
    is_active: true,
    stock: mongoose.trusted({ $lte: t }),
  })
    .sort({ stock: 1 })
    .limit(Math.min(500, Number(limit) || 100))
    .select(
      "name sku barcode stock location thumbnail vendor pricing.tiers pricing.min_price",
    )
    .lean();
};
