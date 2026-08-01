import Cart from "../models/Cart.js";
import Product from "../models/Product.js";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { getRequestIdentity } from "../utils/ownership.js";
import { BadRequestError, ConflictError } from "../utils/errors.js";
import { ORDER_STATUS, PAYMENT_STATUS } from "../utils/constants.js";

import { quoteShippingForOrder } from "../services/shippingService.js";
import { findOrderForOwner } from "../services/orderService.js";

/**
 * Cotiza envío en base al carrito del usuario/invitado y una dirección dada.
 * No persiste nada.
 */
export const previewShipping = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  if (!identity.userId && !identity.guestId) {
    throw new BadRequestError("Identidad requerida");
  }

  const { shipping } = req.body;

  const cartFilter = identity.userId
    ? { user_id: identity.userId, status: "active" }
    : { guest_id: identity.guestId, status: "active" };

  const cart = await Cart.findOne(cartFilter);
  if (!cart || !cart.items?.length) {
    throw new BadRequestError("No hay productos en el carrito");
  }

  // Carga los pesos reales desde Product para cotizar correctamente.
  const productIds = [...new Set(cart.items.map((i) => String(i.product_id)))];
 const products = await Promise.all(
  productIds.map((id) =>
    Product.findById(id).select("weight dimensions").lean()
  )
);

const validProducts = products.filter(Boolean);
 const weightMap = new Map(
  validProducts.map((p) => [
    String(p._id),
    p.weight || { value: 0, unit: "g" },
  ])
);

  const orderLike = {
    items: cart.items.map((it) => ({
      product_id: it.product_id,
      quantity: it.quantity,
      weight: weightMap.get(String(it.product_id)) || { value: 0, unit: "g" },
    })),
    shipping,
  };

  const quote = quoteShippingForOrder(orderLike);

  return res.status(200).json({ success: true, data: quote });
});

/**
 * Cotiza envío para una orden existente. Recalcula en servidor.
 */
export const quoteShipping = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  identity.guestToken = req.body?.guestToken || null;

  const order = await findOrderForOwner({
    orderId: req.body.orderId,
    identity,
    includeGuestToken: true,
  });

  const quote = quoteShippingForOrder(order);

  return res.status(200).json({ success: true, data: quote });
});

/**
 * Aplica un envío a la orden. Recalcula el monto del envío en servidor.
 * No acepta shippingAmount del cliente (jamás).
 */
export const applyShippingToOrder = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  identity.guestToken = req.body?.guestToken || null;

  const order = await findOrderForOwner({
    orderId: req.body.orderId,
    identity,
    includeGuestToken: true,
  });

  if (order.status !== ORDER_STATUS.PENDING) {
    throw new ConflictError(
      "Solo se puede modificar el envío en órdenes pendientes"
    );
  }
  if (
    order.payment?.status !== PAYMENT_STATUS.PENDING &&
    order.payment?.status !== PAYMENT_STATUS.REJECTED
  ) {
    throw new ConflictError(
      "El pago de la orden ya fue procesado, no se puede modificar el envío"
    );
  }

  // Actualizar dirección si vino
  if (req.body.region) order.shipping.region = String(req.body.region).trim();
  if (req.body.city) order.shipping.city = String(req.body.city).trim();

  const quote = quoteShippingForOrder(order);
  const selected = quote.selected;

  order.shipping.amount = Number(selected.amount || 0);
  order.shipping.service_name = selected.service_name || null;
  order.shipping.service_code = selected.service_code || null;
  order.shipping.carrier = selected.carrier || "blueexpress_manual";

  order.shipping_amount = order.shipping.amount;

  // Recalcular total respetando subtotal y discount existentes.
  const subtotal = Number(order.subtotal || 0);
  const discount = Math.min(Number(order.discount_amount || 0), subtotal);
  order.total = Math.max(0, subtotal + order.shipping_amount - discount);
  order.payment.amount = order.total;

  await order.save();

  return res.status(200).json({
    success: true,
    data: {
      order,
      quote,
    },
  });
});

/**
 * Cotiza envío a partir de una lista de items directa (sin carrito).
 * Usado por CustomBox checkout.
 */
export const previewShippingFromItems = asyncHandler(async (req, res) => {
  const { shipping, items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("Se requieren items para cotizar el envío");
  }

  if (!shipping?.region) {
    throw new BadRequestError("Se requiere la región para cotizar el envío");
  }

  const productIds = [...new Set(items.map((i) => String(i.product_id)))];
  const products = await Promise.all(
    productIds.map((id) =>
      Product.findById(id).select("weight dimensions").lean()
    )
  );

  const weightMap = new Map(
    products.filter(Boolean).map((p) => [
      String(p._id),
      p.weight || { value: 0, unit: "g" },
    ])
  );

  const orderLike = {
    items: items.map((it) => ({
      product_id: it.product_id,
      quantity: it.quantity,
      weight: weightMap.get(String(it.product_id)) || { value: 0, unit: "g" },
    })),
    shipping,
  };

  const quote = quoteShippingForOrder(orderLike);

  return res.status(200).json({ success: true, data: quote });
});