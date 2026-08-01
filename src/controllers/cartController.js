import Cart from "../models/Cart.js";
import Product from "../models/Product.js";
import Reservation from "../models/Reservation.js";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { getRequestIdentity } from "../utils/ownership.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors.js";
import { calculateItemPricing, getBoxQty } from "../services/pricingService.js";
import {
  reserveStockAtomic,
  releaseReserved,
} from "../services/stockService.js";

const ownerFilter = (identity) => {
  if (identity.userId) return { user_id: identity.userId, status: "active" };
  if (identity.guestId) return { guest_id: identity.guestId, status: "active" };
  return null;
};

const ownerAssign = (identity) => {
  if (identity.userId) {
    return { user_id: identity.userId, guest_id: null, status: "active" };
  }
  if (identity.guestId) {
    return { user_id: null, guest_id: identity.guestId, status: "active" };
  }
  return null;
};

const recalcCartTotal = (items) =>
  items.reduce((acc, it) => acc + Number(it.subtotal || 0), 0);

const buildCartItem = ({ product, quantity, user }) => {
  if (!product) throw new NotFoundError("Producto no encontrado");
  if (!product.is_active) throw new ConflictError("Producto inactivo");

  const tiers = product?.pricing?.tiers || [];
  // Cibox vende SOLO por caja: normaliza a un múltiplo entero de la caja
  // (mínimo 1 caja), independientemente de lo que pida el cliente.
  const boxQty = getBoxQty(tiers);
  const requestedQty = Number(quantity || 0);
  const normalizedQty = Math.max(1, Math.round(requestedQty / boxQty)) * boxQty;

  const pricing = calculateItemPricing({
    tiers,
    quantity: normalizedQty,
    product,
    user,
  });

  return {
    product_id: product._id,
    name: product.name,
    thumbnail: product.thumbnail || product.images?.[0] || "",
    quantity: pricing.quantity,
    unit_price: pricing.unit_price,
    subtotal: pricing.subtotal,
    tier_label: pricing.tier_label,
    box_qty: boxQty,
    product_type:
      product.product_type === "box" ? "box" : "individual",
    box_items: [],
  };
};

const requireIdentity = (identity) => {
  if (!identity.userId && !identity.guestId) {
    throw new BadRequestError(
      "No se pudo identificar el carrito. Falta token o x-guest-id válido."
    );
  }
};

const reservationTtl = () =>
  new Date(Date.now() + env.CART_RESERVATION_TTL_MINUTES * 60 * 1000);

const reservationOwner = (cart) => ({
  cart_id: cart._id,
  user_id: cart.user_id || null,
  guest_id: cart.guest_id || null,
});

/**
 * Reserva el delta de unidades para una línea y upsert de la Reservation con
 * TTL renovado. Si no hay disponible → ConflictError "Quedan N disponibles"
 * (este sí se propaga: bloquea la acción del carrito intencionalmente).
 *
 * targetUnits = total de unidades que la línea debe tener tras la operación.
 * currentUnits = total reservado actualmente para esa línea.
 */
const reserveLine = async ({ cart, productId, targetUnits, currentUnits, boxQty }) => {
  const delta = Number(targetUnits) - Number(currentUnits || 0);

  if (delta !== 0) {
    // Lanza ConflictError "Quedan N disponibles" si no alcanza al subir.
    // (Único error que se propaga a propósito: bloquea la acción del carrito.)
    await reserveStockAtomic({ productId, delta });
  }

  // Bookkeeping de la Reservation: defensivo, no debe romper el flujo si falla.
  // El contador `reserved` ya se ajustó atómicamente arriba.
  try {
    if (Number(targetUnits) <= 0) {
      await Reservation.findOneAndUpdate(
        { cart_id: cart._id, product_id: productId, status: "active" },
        { $set: { status: "released" } }
      );
      return;
    }

    await Reservation.findOneAndUpdate(
      { cart_id: cart._id, product_id: productId, status: "active" },
      {
        $set: {
          ...reservationOwner(cart),
          product_id: productId,
          quantity: Number(targetUnits),
          box_qty: Number(boxQty || 1),
          status: "active",
          expires_at: reservationTtl(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    logger.warn(
      { err: err.message, productId: String(productId) },
      "reserva: upsert de Reservation falló (reserved ya ajustado)"
    );
  }
};

/**
 * Libera la reserva de una línea: decrementa Product.reserved y marca la
 * Reservation como released. Defensivo: nunca lanza.
 */
const closeReservation = async ({ cart, productId }) => {
  const reservation = await Reservation.findOneAndUpdate(
    { cart_id: cart._id, product_id: productId, status: "active" },
    { $set: { status: "released" } },
    { new: true }
  );

  const qty = Number(reservation?.quantity || 0);
  if (qty > 0) {
    await releaseReserved({ productId, qty });
  }
};

/**
 * Lazy release: trata como liberada cualquier reserva activa ya vencida del
 * carrito (decrementa reserved y marca released). No bloquea la lectura si algo
 * falla. Devuelve el Set de product_id liberados para reflejarlo en el carrito.
 */
const lazyReleaseExpired = async (cart) => {
  const released = new Set();
  try {
    const expired = await Reservation.find({
      cart_id: cart._id,
      status: "active",
      expires_at: { $lt: new Date() },
    })
      .select("_id product_id quantity")
      .lean();

    for (const r of expired) {
      try {
        await Reservation.updateOne(
          { _id: r._id, status: "active" },
          { $set: { status: "released" } }
        );
        if (Number(r.quantity) > 0) {
          await releaseReserved({ productId: r.product_id, qty: Number(r.quantity) });
        }
        released.add(String(r.product_id));
      } catch (err) {
        logger.warn(
          { err: err.message, reservationId: String(r._id) },
          "lazy release: reserva omitida"
        );
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, "lazy release: barrido falló");
  }
  return released;
};

/* ------------------------------- handlers -------------------------------- */

export const getCart = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  requireIdentity(identity);

  const filter = ownerFilter(identity);
  let cart = await Cart.findOne(filter);

  if (!cart) {
    cart = await Cart.create({
      ...ownerAssign(identity),
      items: [],
      total: 0,
    });
  }

  // Lazy release: libera reservas vencidas aunque el job aún no haya pasado, y
  // saca esas líneas del carrito para que el cliente vea el estado real.
  const released = await lazyReleaseExpired(cart);
  if (released.size > 0) {
    try {
      const before = cart.items.length;
      cart.items = cart.items.filter(
        (it) => !released.has(String(it.product_id))
      );
      if (cart.items.length !== before) {
        cart.total = recalcCartTotal(cart.items);
        await cart.save();
      }
    } catch (err) {
      logger.warn({ err: err.message }, "getCart: limpieza de líneas vencidas falló");
    }
  }

  return res.status(200).json({
    success: true,
    data: cart,
  });
});

export const addItem = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  requireIdentity(identity);

  const { productId, quantity } = req.body;

  const product = await Product.findById(productId);
  if (!product || !product.is_active) {
    throw new NotFoundError("Producto no encontrado o inactivo");
  }

  const filter = ownerFilter(identity);
  let cart = await Cart.findOne(filter);
  if (!cart) {
    cart = await Cart.create({
      ...ownerAssign(identity),
      items: [],
      total: 0,
    });
  }

  const idx = cart.items.findIndex(
    (it) => String(it.product_id) === String(productId)
  );

  const existingQty = idx >= 0 ? Number(cart.items[idx].quantity || 0) : 0;
  const newQty = existingQty + Number(quantity);

  const built = buildCartItem({
    product,
    quantity: newQty,
    user: req.user,
  });

  // Reservar el delta ANTES de guardar el carrito: si no hay disponible,
  // reserveLine lanza 409 y el carrito no se modifica.
  await reserveLine({
    cart,
    productId: product._id,
    targetUnits: built.quantity,
    currentUnits: existingQty,
    boxQty: built.box_qty,
  });

  if (idx >= 0) {
    cart.items[idx].quantity = built.quantity;
    cart.items[idx].unit_price = built.unit_price;
    cart.items[idx].subtotal = built.subtotal;
    cart.items[idx].tier_label = built.tier_label;
    cart.items[idx].box_qty = built.box_qty;
    cart.items[idx].name = built.name;
    cart.items[idx].thumbnail = built.thumbnail;
  } else {
    cart.items.push(built);
  }

  cart.total = recalcCartTotal(cart.items);
  await cart.save();

  return res.status(200).json({ success: true, data: cart });
});

export const updateItem = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  requireIdentity(identity);

  const { productId } = req.params;
  const { quantity } = req.body;

  const cart = await Cart.findOne(ownerFilter(identity));
  if (!cart) throw new NotFoundError("Carrito no encontrado");

  const idx = cart.items.findIndex(
    (it) => String(it.product_id) === String(productId)
  );
  if (idx < 0) throw new NotFoundError("Producto no existe en el carrito");

  const product = await Product.findById(productId);
  if (!product || !product.is_active) {
    throw new NotFoundError("Producto no encontrado o inactivo");
  }

  const built = buildCartItem({
    product,
    quantity: Number(quantity),
    user: req.user,
  });

  const prevUnits = Number(cart.items[idx].quantity || 0);

  // Ajusta la reserva al nuevo total (sube=reserva delta, baja=libera) y
  // renueva el TTL. Si sube y no hay disponible → 409, no se guarda el carrito.
  await reserveLine({
    cart,
    productId: product._id,
    targetUnits: built.quantity,
    currentUnits: prevUnits,
    boxQty: built.box_qty,
  });

  cart.items[idx].quantity = built.quantity;
  cart.items[idx].unit_price = built.unit_price;
  cart.items[idx].subtotal = built.subtotal;
  cart.items[idx].tier_label = built.tier_label;
  cart.items[idx].box_qty = built.box_qty;

  cart.total = recalcCartTotal(cart.items);
  await cart.save();

  return res.status(200).json({ success: true, data: cart });
});

export const removeItem = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  requireIdentity(identity);

  const { productId } = req.params;

  const cart = await Cart.findOne(ownerFilter(identity));
  if (!cart) throw new NotFoundError("Carrito no encontrado");

  const before = cart.items.length;
  cart.items = cart.items.filter(
    (it) => String(it.product_id) !== String(productId)
  );

  if (cart.items.length === before) {
    throw new NotFoundError("Producto no existe en el carrito");
  }

  // Libera la reserva de la línea (defensivo: no bloquea el quitar del carrito).
  try {
    await closeReservation({ cart, productId });
  } catch (err) {
    logger.warn(
      { err: err.message, productId: String(productId) },
      "removeItem: liberación de reserva falló"
    );
  }

  cart.total = recalcCartTotal(cart.items);
  await cart.save();

  return res.status(200).json({ success: true, data: cart });
});

export const clearCart = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  requireIdentity(identity);

  const cart = await Cart.findOne(ownerFilter(identity));
  if (!cart) throw new NotFoundError("Carrito no encontrado");

  // Libera todas las reservas activas del carrito (defensivo, por línea).
  try {
    for (const it of cart.items) {
      await closeReservation({ cart, productId: it.product_id });
    }
  } catch (err) {
    logger.warn({ err: err.message }, "clearCart: liberación de reservas falló");
  }

  cart.items = [];
  cart.total = 0;
  await cart.save();

  return res.status(200).json({ success: true, data: cart });
});
