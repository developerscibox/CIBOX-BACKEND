import { BadRequestError } from "../utils/errors.js";
import { env } from "../config/env.js";

const PANTRY_DISCOUNT_PERCENT = env.PANTRY_DISCOUNT;
const CIBOX_PLUS_DISCOUNT_PERCENT = env.CIBOX_PLUS_DISCOUNT;
// Unidades por caja: min_qty del tier mayor. Cibox vende solo por caja.
export const getBoxQty = (tiers) => {
  if (!Array.isArray(tiers) || tiers.length === 0) return 1;
  const max = tiers.reduce((m, t) => Math.max(m, Number(t?.min_qty || 1)), 1);
  return max > 1 ? max : 1;
};

export const getPriceTierByQuantity = (tiers, quantity) => {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new BadRequestError("El producto no tiene tiers de precio");
  }

  const qty = Number(quantity || 0);
  if (qty < 1) throw new BadRequestError("Cantidad inválida");

  const sortedTiers = [...tiers].sort((a, b) => a.min_qty - b.min_qty);
  let selectedTier = sortedTiers[0];

  for (const tier of sortedTiers) {
    if (qty >= Number(tier.min_qty || 1)) {
      selectedTier = tier;
    }
  }

  return selectedTier;
};

const buildDiscountResult = (price, discountPercent, source) => {
  const pct = Number(discountPercent || 0);
  if (!pct || pct <= 0) {
    return {
      original_price: price,
      final_price: price,
      discount_applied: false,
      discount_percent: 0,
      discount_amount: 0,
      discount_source: null,
    };
  }

  const discountAmount = Math.round(price * (pct / 100));
  const finalPrice = price - discountAmount;

  return {
    original_price: price,
    final_price: finalPrice,
    discount_applied: true,
    discount_percent: pct,
    discount_amount: discountAmount,
    discount_source: source,
  };
};

export const applyBestDiscount = ({
  price,
  product,
  user,
  fromPantry = false,
}) => {
  if (fromPantry) {
    return buildDiscountResult(price, PANTRY_DISCOUNT_PERCENT, "pantry");
  }

  const hasActiveSubscription =
    user?.subscription?.type === "cibox_plus" &&
    user?.subscription?.status === "active";

  const productAllowsCiboxPlus = product?.cibox_plus?.enabled === true;

  if (hasActiveSubscription && productAllowsCiboxPlus) {
    return buildDiscountResult(
      price,
      CIBOX_PLUS_DISCOUNT_PERCENT,
      "cibox_plus",
    );
  }

  return buildDiscountResult(price, 0, null);
};

/**
 * Calcula pricing de un item, considerando tier por cantidad y descuentos.
 * Siempre se calcula server-side: no se confía en valores del cliente.
 */
export const calculateItemPricing = ({
  tiers,
  quantity,
  product,
  user,
  fromPantry = false,
}) => {
  const selectedTier = getPriceTierByQuantity(tiers, quantity);
  const qty = Number(quantity);

  const discountResult = applyBestDiscount({
    price: Number(selectedTier.price || 0),
    product,
    user,
    fromPantry,
  });

  return {
    unit_price: discountResult.final_price,
    original_unit_price: discountResult.original_price,
    tier_label: selectedTier.label,
    min_qty_applied: selectedTier.min_qty,
    quantity: qty,
    discount_applied: discountResult.discount_applied,
    discount_percent: discountResult.discount_percent,
    discount_amount_per_unit: discountResult.discount_amount,
    discount_source: discountResult.discount_source,
    subtotal: discountResult.final_price * qty,
    original_subtotal: discountResult.original_price * qty,
  };
};
