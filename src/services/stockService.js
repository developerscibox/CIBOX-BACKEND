import mongoose from "mongoose";
import Product from "../models/Product.js";
import Reservation from "../models/Reservation.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const decrementStockAtomic = async ({ productId, quantity }, session) => {
  const qty = Number(quantity || 0);

  if (qty <= 0) {
    throw new ConflictError("Cantidad inválida para descontar stock");
  }

  const updated = await Product.collection.findOneAndUpdate(
    {
      _id: productId,
      is_active: true,
      stock: { $gte: qty },
    },
    {
      $inc: { stock: -qty },
    },
    {
      returnDocument: "after",
      session,
    }
  );

  const updatedProduct = updated?.value || updated;

  if (!updatedProduct) {
    const product = await Product.findById(productId)
      .session(session || null)
      .lean();

    if (!product) {
      throw new NotFoundError(`Producto ${productId} no encontrado`);
    }

    if (!product.is_active) {
      throw new ConflictError(`Producto inactivo: ${product.name}`);
    }

    logger.warn(
      { productId, requested: qty, available: product.stock },
      "stock insuficiente al descontar"
    );

    throw new ConflictError(
      `Stock insuficiente para ${product.name} (disponible: ${product.stock}, requerido: ${qty})`
    );
  }

  return updatedProduct;
};
/**
 * Restaura stock (cancelaciones/reembolsos). Idempotente a nivel de cantidad.
 */
export const restoreStock = async ({ productId, quantity }, session) => {
  const qty = Number(quantity || 0);
  if (qty <= 0) return null;

  return Product.findByIdAndUpdate(
    productId,
    { $inc: { stock: qty } },
    { new: true, session }
  );
};

/* ------------------------- ASIGNACIÓN (allocated) ------------------------- *
 * Fase 4 — inventario en 3 estados. Al confirmar la orden el físico (stock) NO
 * baja: se COMPROMETE (allocated). El físico baja recién en el pick (commitPick).
 * DISPONIBLE = stock − reserved − allocated.                                 */

/**
 * Compromete `quantity` unidades a una orden (checkout). Guard atómico: el
 * disponible (stock − reserved − allocated) debe cubrir la cantidad.
 */
export const allocateStockAtomic = async ({ productId, quantity }, session) => {
  const qty = Number(quantity || 0);
  if (qty <= 0) throw new ConflictError("Cantidad inválida para asignar stock");

  const updated = await Product.collection.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(productId)),
      is_active: true,
      $expr: {
        $gte: [
          { $subtract: ["$stock", { $add: [{ $ifNull: ["$reserved", 0] }, { $ifNull: ["$allocated", 0] }] }] },
          qty,
        ],
      },
    },
    { $inc: { allocated: qty } },
    { returnDocument: "after", session },
  );

  const updatedProduct = updated?.value || updated;
  if (!updatedProduct) {
    const product = await Product.findById(productId).session(session || null).lean();
    if (!product) throw new NotFoundError(`Producto ${productId} no encontrado`);
    if (!product.is_active) throw new ConflictError(`Producto inactivo: ${product.name}`);
    const available = Math.max(
      0,
      Number(product.stock || 0) - Number(product.reserved || 0) - Number(product.allocated || 0),
    );
    logger.warn({ productId: String(productId), requested: qty, available }, "asignación: disponible insuficiente");
    throw new ConflictError(
      `Stock insuficiente para ${product.name} (disponible: ${available}, requerido: ${qty})`,
    );
  }
  return updatedProduct;
};

/**
 * Confirma el pick: el físico SALE de bodega. Decrementa stock (guard stock≥qty)
 * y libera la cantidad comprometida (allocated). Ambas en la misma transacción.
 */
export const commitPick = async ({ productId, quantity }, session) => {
  const qty = Number(quantity || 0);
  if (qty <= 0) return null;

  // Camino normal (Fase 4): hay cantidad comprometida → el físico sale ahora.
  // Guard atómico sobre stock Y allocated para no descontar de más.
  const committed = await Product.collection.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(productId)),
      stock: { $gte: qty },
      allocated: { $gte: qty },
    },
    { $inc: { stock: -qty, allocated: -qty } },
    { returnDocument: "after", session },
  );
  const c = committed?.value || committed;
  if (c) return c;

  // Sin allocated suficiente: orden legacy (pre-Fase 4) cuyo físico YA se
  // descontó al crear. No se vuelve a descontar stock; solo se limpia allocated.
  const product = await Product.findById(productId).session(session || null).lean();
  if (!product) throw new NotFoundError(`Producto ${productId} no encontrado`);
  await releaseAllocated({ productId, qty }, session);
  return product;
};

/**
 * Libera `qty` unidades comprometidas (cancelación/expiración ANTES del pick).
 * No toca el físico (nunca salió). Defensivo: nunca baja allocated de 0.
 */
export const releaseAllocated = async ({ productId, qty }, session) => {
  const q = Number(qty || 0);
  if (q <= 0) return null;

  const updated = await Product.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(String(productId)), allocated: { $gte: q } },
    { $inc: { allocated: -q } },
    { returnDocument: "after", session },
  );
  const up = updated?.value || updated;
  if (up) return up;

  // Deriva (allocated < q): ajusta a 0 sin negativos.
  const reset = await Product.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(String(productId)), allocated: { $gt: 0 } },
    { $set: { allocated: 0 } },
    { returnDocument: "after", session },
  );
  return reset?.value || reset || null;
};

/**
 * Verifica disponibilidad de stock sin descontar (read-only).
 * Útil para validaciones previas a la creación de la orden.
 */
export const checkStockAvailability = async ({ productId, quantity }, session) => {
  const product = await Product.findById(productId)
    .session(session || null)
    .lean();

  if (!product) throw new NotFoundError(`Producto ${productId} no encontrado`);
  if (!product.is_active) throw new ConflictError(`Producto inactivo: ${product.name}`);

  const qty = Number(quantity || 0);
  if (product.stock < qty) {
    throw new ConflictError(
      `Stock insuficiente para ${product.name} (disponible: ${product.stock}, requerido: ${qty})`
    );
  }

  return product;
};

/* ----------------------------- RESERVAS ----------------------------------- *
 * Reserva temporal de stock para el carrito. NO toca el físico (stock); solo
 * mueve el contador `reserved`. DISPONIBLE = stock − reserved.               */

/**
 * Reserva (delta > 0) o libera (delta < 0) unidades de forma atómica.
 *
 * - delta > 0: guard `stock − reserved >= delta` vía $expr, luego $inc reserved.
 *   Si no hay disponible → ConflictError con el disponible real.
 * - delta < 0: $inc reserved += delta acotado para no bajar de 0 (guard
 *   `reserved >= -delta`); si por deriva no alcanza, ajusta a 0.
 *
 * Mismo patrón atómico que decrementStockAtomic (no toca stock físico).
 */
export const reserveStockAtomic = async ({ productId, delta }, session) => {
  const d = Number(delta || 0);
  if (d === 0) return null;

  if (d > 0) {
    const updated = await Product.collection.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(String(productId)),
        is_active: true,
        // disponible (stock − reserved − allocated) debe cubrir el delta.
        // $ifNull: productos existentes aún no tienen reserved/allocated.
        $expr: {
          $gte: [
            { $subtract: ["$stock", { $add: [{ $ifNull: ["$reserved", 0] }, { $ifNull: ["$allocated", 0] }] }] },
            d,
          ],
        },
      },
      { $inc: { reserved: d } },
      { returnDocument: "after", session }
    );

    const updatedProduct = updated?.value || updated;

    if (!updatedProduct) {
      const product = await Product.findById(productId)
        .session(session || null)
        .lean();

      if (!product) throw new NotFoundError(`Producto ${productId} no encontrado`);
      if (!product.is_active) {
        throw new ConflictError(`Producto inactivo: ${product.name}`);
      }

      const available = Math.max(
        0,
        Number(product.stock || 0) - Number(product.reserved || 0) - Number(product.allocated || 0)
      );
      logger.warn(
        { productId: String(productId), requested: d, available },
        "reserva: disponible insuficiente"
      );
      throw new ConflictError(`Quedan ${available} disponibles`);
    }

    return updatedProduct;
  }

  // delta < 0 → liberar |d| unidades sin bajar de 0
  return releaseReserved({ productId, qty: -d }, session);
};

/**
 * Libera `qty` unidades reservadas (decrementa reserved, mínimo 0).
 * Idempotente y defensivo: nunca lanza por liberar de más.
 */
export const releaseReserved = async ({ productId, qty }, session) => {
  const q = Number(qty || 0);
  if (q <= 0) return null;

  // Caso normal: hay suficiente reserved → decremento exacto.
  const updated = await Product.collection.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(productId)),
      reserved: { $gte: q },
    },
    { $inc: { reserved: -q } },
    { returnDocument: "after", session }
  );

  const updatedProduct = updated?.value || updated;
  if (updatedProduct) return updatedProduct;

  // Deriva (reserved < q): ajusta reserved a 0 sin quedar negativo.
  const reset = await Product.collection.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(productId)),
      reserved: { $gt: 0 },
    },
    { $set: { reserved: 0 } },
    { returnDocument: "after", session }
  );

  return reset?.value || reset || null;
};

/**
 * Confirma una reserva al concretar la venta: marca la Reservation como
 * `confirmed` y libera el contador `reserved` (el físico lo descuenta
 * decrementStockAtomic en la misma transacción del checkout, para que el ítem
 * no cuente doble). Defensivo: si no hay reserva activa, solo es un no-op.
 */
export const confirmReservation = async (
  { cartId, productId, quantity },
  session
) => {
  const filter = { product_id: productId, status: "active" };
  if (cartId) filter.cart_id = cartId;

  const reservation = await Reservation.findOneAndUpdate(
    filter,
    { $set: { status: "confirmed" } },
    { new: true, session: session || null }
  );

  const qtyToRelease = Number(
    quantity != null ? quantity : reservation?.quantity || 0
  );

  if (qtyToRelease > 0) {
    await releaseReserved({ productId, qty: qtyToRelease }, session);
  }

  return reservation;
};
