import Cart from "../models/Cart.js";
import Product from "../models/Product.js";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { getRequestIdentity } from "../utils/ownership.js";
import { BadRequestError, ConflictError } from "../utils/errors.js";
import { ORDER_STATUS, PAYMENT_STATUS } from "../utils/constants.js";

import { quoteShippingForOrder } from "../services/shippingService.js";
import { calculateItemPricing } from "../services/pricingService.js";
import { CARRIER_DESPACHO } from "../config/despacho.js";
import { findOrderForOwner } from "../services/orderService.js";

/**
 * Campos de Product que necesita una cotización: el peso arma el bulto y el
 * resto lo consume `calculateItemPricing` (tramos por cantidad, descuento de
 * despensa, descuento Cibox Plus).
 */
const SELECT_PARA_COTIZAR = "weight dimensions pricing cibox_plus is_active";

/**
 * Cuánto vale esta mercadería, calculado en el SERVIDOR contra los precios de
 * la base. Es el número que decide el envío gratis, así que no puede salir del
 * navegador ni de la foto congelada en el carrito.
 *
 * Por qué no sirve `cartItem.subtotal`: ese campo se escribe cuando el producto
 * entra al carrito y se queda quieto. `rebuildItemsFromCart` lo recalcula al
 * crear el pedido —con el tramo que corresponda a la cantidad de ese momento y
 * con el descuento de despensa— y puede dar otro número. Un carrito de despensa
 * de 60.500 congelados que en realidad vale 59.400 mostraría "envío gratis" y
 * Webpay cobraría la tarifa: exactamente la falla que este cálculo evita.
 *
 * Un ítem que no se puede valorizar (producto borrado, sin tramos de precio,
 * cantidad inválida) suma 0. Se equivoca hacia COBRAR el despacho, nunca hacia
 * regalarlo.
 */
const subtotalDeItems = ({ items, productMap, user, fromPantry }) => {
  const suma = (Array.isArray(items) ? items : []).reduce((acc, it) => {
    const product = productMap.get(String(it.product_id));
    const quantity = Number(it?.quantity) || 0;
    if (!product || quantity < 1) return acc;

    try {
      const pricing = calculateItemPricing({
        tiers: product.pricing?.tiers || [],
        quantity,
        product,
        user: user || null,
        fromPantry: Boolean(fromPantry),
      });
      return acc + (Number(pricing.subtotal) || 0);
    } catch {
      // Producto sin tramos de precio: no se puede valorizar y no frena la
      // cotización. La dirección segura es no sumarlo.
      return acc;
    }
  }, 0);

  return Math.max(0, Math.round(suma));
};

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

  // Se cargan pesos Y precios. El peso arma el bulto; el precio decide si el
  // pedido llega al mínimo de envío gratis, y ese número NO puede salir del
  // navegador ni del carrito guardado (ver `subtotalDeItems`).
  const productIds = [...new Set(cart.items.map((i) => String(i.product_id)))];
  const products = await Promise.all(
    productIds.map((id) =>
      Product.findById(id).select(SELECT_PARA_COTIZAR).lean()
    )
  );

  const productMap = new Map(
    products.filter(Boolean).map((p) => [String(p._id), p])
  );

  const orderLike = {
    items: cart.items.map((it) => ({
      product_id: it.product_id,
      quantity: it.quantity,
      weight: productMap.get(String(it.product_id))?.weight || {
        value: 0,
        unit: "g",
      },
    })),
    // El mismo cálculo que hará `rebuildItemsFromCart` al crear el pedido, con
    // el mismo `fromPantry` y el mismo usuario. Tiene que ser el mismo o esta
    // vista previa dice una cosa y Webpay cobra otra.
    subtotal: subtotalDeItems({
      items: cart.items,
      productMap,
      user: req.user,
      fromPantry: Boolean(cart.from_pantry),
    }),
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

  // Si la comuna nueva está fuera de zona, quoteShippingForOrder lanza 400 y no
  // se guarda nada: este endpoint no puede usarse para mover un pedido ya
  // creado fuera del área de reparto.
  const quote = quoteShippingForOrder(order);
  const selected = quote.selected;

  // Guardar comuna y región canónicas (las que resolvió la cotización).
  order.shipping.city = quote.meta.comuna;
  order.shipping.region = quote.meta.region;

  order.shipping.amount = Number(selected.amount || 0);
  order.shipping.service_name = selected.service_name || null;
  order.shipping.service_code = selected.service_code || null;
  order.shipping.carrier = selected.carrier || CARRIER_DESPACHO;

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
  // Aquí los ítems los manda el cliente, así que el precio TIENE que salir de
  // la base. Si el monto viniera del cuerpo del request, cualquiera pediría una
  // cotización con precios inventados y se llevaría un "despacho gratis" que el
  // pedido real no le va a dar. Antes bastaba con el peso porque el peso no
  // cambiaba el precio; el monto sí.
  const products = await Promise.all(
    productIds.map((id) =>
      Product.findById(id).select(SELECT_PARA_COTIZAR).lean()
    )
  );

  const productMap = new Map(
    products.filter(Boolean).map((p) => [String(p._id), p])
  );

  const orderLike = {
    items: items.map((it) => ({
      product_id: it.product_id,
      quantity: Number(it.quantity) || 0,
      weight: productMap.get(String(it.product_id))?.weight || {
        value: 0,
        unit: "g",
      },
    })),
    // Sin carrito no hay despensa, y sin sesión no hay Cibox Plus.
    subtotal: subtotalDeItems({
      items,
      productMap,
      user: req.user,
      fromPantry: false,
    }),
    shipping,
  };

  const quote = quoteShippingForOrder(orderLike);

  return res.status(200).json({ success: true, data: quote });
});