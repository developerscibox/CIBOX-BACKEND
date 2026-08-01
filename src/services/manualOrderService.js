import mongoose from "mongoose";

import Order from "../models/Order.js";
import Product from "../models/Product.js";

import {
  ORDER_STATUS,
  PAYMENT_STATUS,
  MOVEMENT_TYPES,
} from "../utils/constants.js";
import { withTransaction } from "../utils/transactions.js";
import { logger } from "../utils/logger.js";
import { BadRequestError, ConflictError } from "../utils/errors.js";
import { formatRut } from "../utils/rut.js";

import { calculateItemPricing, getBoxQty } from "./pricingService.js";
import { emitDocumentForOrder } from "./siiService.js";
import { decrementStockAtomic } from "./stockService.js";
import {
  logOrderStockMovements,
  consumeBatchesFEFO,
  recomputeProductExpiry,
} from "./inventoryService.js";

/**
 * CARGA MANUAL DE VENTAS (venta presencial en bodega).
 *
 * Crea una Order real (source 'manual', delivery_method 'pickup') vendiendo POR
 * CAJA: el operador indica cuántas cajas de cada producto, y el servicio traduce
 * cajas → unidades vía getBoxQty(tiers) y resuelve el precio server-side con
 * calculateItemPricing (tier.price es POR UNIDAD; el subtotal lo calcula el
 * pricing). Todo ocurre dentro de UNA transacción (withTransaction): descuento
 * de stock (decrementStockAtomic) + Kardex StockMovement type 'venta' sign -1
 * (logOrderStockMovements). Si algún descuento falla por stock insuficiente,
 * decrementStockAtomic lanza ConflictError y la transacción revierte TODO
 * (stock + orden + kardex): nunca queda inventario descuadrado.
 *
 * La orden resultante entra sin cambios en /admin/dashboard, /admin/sales-summary,
 * /admin/top-products, /admin/orders y exportOrdersCSV; el StockMovement aparece
 * en /inventory/movements (Kardex). source 'manual' permite distinguir las ventas
 * presenciales de las del carrito.
 *
 * NOTA (cableado del CTO): el enum `source` del modelo Order debe incluir 'manual'
 * (models/Order.js). Hasta que se agregue, Order.create rechazará el documento.
 */

// Dirección física de retiro en bodega (misma constante que orderService).
const PICKUP_LOCATION =
  "Av. Lo Espejo 01565, Bodega 826, Centro Logístico Mersan, Lo Espejo";

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();

const buildManualCustomer = (raw = {}) => {
  const fullName = String(raw.fullName || "").trim();
  if (!fullName) {
    throw new BadRequestError("El nombre del cliente es obligatorio", {
      fullName: "Nombre requerido",
    });
  }
  return {
    fullName,
    email: raw.email ? normalizeEmail(raw.email) : null,
    phone: raw.phone ? String(raw.phone).trim() : null,
    rut: raw.rut ? formatRut(raw.rut) : null,
  };
};

/**
 * Reconstruye los items de la orden traduciendo cajas → unidades.
 * Una sola Product.find({_id:{$in}}) para evitar N+1. Por item:
 * quantity = cajas * getBoxQty(tiers), precio server-side vía calculateItemPricing
 * y descuento atómico de stock acumulando stockAfterMap.
 */
const rebuildItemsFromBoxes = async ({ rawItems, session }) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new BadRequestError("La venta no tiene productos");
  }

  const productIds = [...new Set(rawItems.map((i) => String(i.product_id)))];

  const products = await Product.find({
    _id: mongoose.trusted({ $in: productIds }),
  })
    .session(session || null)
    .lean();

  const map = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  const stockAfterMap = new Map();
  let subtotal = 0;

  for (const raw of rawItems) {
    const product = map.get(String(raw.product_id));
    if (!product) throw new ConflictError("Producto no encontrado");
    if (!product.is_active)
      throw new ConflictError(`Producto inactivo: ${product.name}`);

    const cajas = Number(raw.cajas || 0);
    if (!Number.isInteger(cajas) || cajas < 1) {
      throw new BadRequestError(
        `Cantidad de cajas inválida para ${product.name}`,
      );
    }

    const tiers = product?.pricing?.tiers || [];
    const boxQty = getBoxQty(tiers);
    const quantity = cajas * boxQty;

    // Precio server-side: tier de mayor min_qty (caja). user:null = sin
    // descuentos de pantry/cibox_plus (venta presencial a precio de caja).
    const pricing = calculateItemPricing({
      tiers,
      quantity,
      product,
      user: null,
    });

    const updatedProduct = await decrementStockAtomic(
      { productId: product._id, quantity: pricing.quantity },
      session,
    );
    stockAfterMap.set(String(product._id), updatedProduct?.stock ?? null);

    // Capa ADITIVA de lotes (best-effort), mismo patrón que commitOrderPick:
    // consume FEFO por lote, anota la trazabilidad en item.batches y recalcula
    // el vencimiento del producto. JAMÁS propaga — si la capa de lotes falla,
    // la venta continúa (el stock es la verdad).
    let batches = [];
    try {
      const consumed = await consumeBatchesFEFO(
        { productId: product._id, quantity: pricing.quantity },
        session,
      );
      if (Array.isArray(consumed) && consumed.length) batches = consumed;
      await recomputeProductExpiry(product._id, session);
    } catch (batchErr) {
      logger.warn(
        { productId: String(product._id), err: batchErr?.message },
        "consumo de lotes (FEFO) falló en venta manual — continúa (best-effort)",
      );
    }

    items.push({
      product_id: product._id,
      name: product.name,
      quantity: pricing.quantity,
      price: pricing.unit_price,
      original_price: pricing.original_unit_price,
      tier_label: pricing.tier_label,
      discount_applied: pricing.discount_applied,
      discount_percent: pricing.discount_percent,
      discount_amount_per_unit: pricing.discount_amount_per_unit,
      discount_source: pricing.discount_source,
      subtotal: pricing.subtotal,
      original_subtotal: pricing.original_subtotal,
      batches,
      product_type: product.product_type === "box" ? "box" : "simple",
      weight: product.weight || { value: 0, unit: "g" },
      dimensions: product.dimensions || {
        length: 0,
        width: 0,
        height: 0,
        unit: "cm",
      },
    });

    subtotal += pricing.subtotal;
  }

  return { items, subtotal, stockAfterMap };
};

const computeManualTotals = ({ subtotal, discountAmount }) => {
  const sub = Math.max(0, Math.round(Number(subtotal || 0)));
  const disc = Math.min(
    sub,
    Math.max(0, Math.round(Number(discountAmount || 0))),
  );
  return {
    subtotal: sub,
    discount_amount: disc,
    total: Math.max(0, sub - disc),
  };
};

/**
 * Crea una venta manual (transaccional). El estado por defecto es 'delivered'
 * (entrega inmediata en mostrador); 'paid' si se cobra pero aún no se entrega.
 *
 * @param {Object} params
 * @param {Array<{product_id, cajas}>} params.items
 * @param {{fullName, email?, phone?, rut?}} params.customer
 * @param {'cash_on_pickup'|'transfer'} params.payment_method
 * @param {'paid'|'delivered'} [params.status]  (default 'delivered')
 * @param {number} [params.discountAmount]
 * @param {string} [params.notes]
 * @param {{user_id, role, label}} [params.by]  actor (admin de bodega)
 * @returns {Promise<Order>}
 */
export const createManualOrder = async ({
  items: rawItems,
  customer: rawCustomer,
  payment_method,
  status,
  discountAmount = 0,
  notes,
  by = null,
}) => {
  const customer = buildManualCustomer(rawCustomer);

  const paymentMethod =
    payment_method === "transfer" ? "transfer" : "cash_on_pickup";

  const finalStatus =
    status === ORDER_STATUS.PAID ? ORDER_STATUS.PAID : ORDER_STATUS.DELIVERED;

  const actor = by || { label: "bodega" };

  return withTransaction(async (session) => {
    const { items, subtotal, stockAfterMap } = await rebuildItemsFromBoxes({
      rawItems,
      session,
    });

    const totals = computeManualTotals({ subtotal, discountAmount });
    const now = new Date();

    const payload = {
      user_id: null,
      guest_id: null,
      items,
      customer,
      source: "manual",
      delivery_method: "pickup",
      pickup: {
        committed_date: now,
        location: PICKUP_LOCATION,
        picked_up_at: finalStatus === ORDER_STATUS.DELIVERED ? now : null,
      },
      payment: {
        method: paymentMethod,
        platform: "web",
        status: PAYMENT_STATUS.APPROVED,
        amount: totals.total,
      },
      coupon: { code: null, coupon_id: null, discount_amount: totals.discount_amount },
      subtotal: totals.subtotal,
      shipping_amount: 0,
      discount_amount: totals.discount_amount,
      total: totals.total,
      status: finalStatus,
      // Venta presencial: el físico ya salió al crear (decrementStockAtomic), así
      // que el pick ya cuenta como "hecho" para cancelación/reembolso (Fase 4).
      stock_committed: true,
      paid_at: now,
      delivered_at: finalStatus === ORDER_STATUS.DELIVERED ? now : null,
      notes: String(notes || "").trim() || null,
      status_history: [
        {
          status: finalStatus,
          changed_at: now,
          note: "Venta manual (carga admin)",
          changed_by: {
            user_id: actor.user_id || null,
            role: actor.role || null,
            label: actor.label || "bodega",
          },
        },
      ],
    };

    const [order] = await Order.create([payload], { session });

    // Kardex: una fila 'venta' sign -1 por producto, asociada a la orden.
    await logOrderStockMovements(
      {
        order,
        type: MOVEMENT_TYPES.SALE,
        sign: -1,
        reason: "Venta manual (carga admin)",
        by: actor,
        stockAfterMap,
      },
      session,
    );

    logger.info(
      {
        orderId: String(order._id),
        total: order.total,
        items: order.items.length,
        by: actor.label,
      },
      "venta manual creada",
    );

    // Boleta (stub SII) best-effort para la venta presencial (efectivo/transfer).
    try {
      await emitDocumentForOrder(order, "boleta");
    } catch (e) {
      logger.warn({ orderId: String(order._id), err: e.message }, "boleta best-effort falló");
    }

    return order;
  });
};

export default { createManualOrder };
