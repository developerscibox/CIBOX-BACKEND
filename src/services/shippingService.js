import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { BadRequestError } from "../utils/errors.js";

/* -------------------------------- helpers -------------------------------- */

const normalizeText = (value = "") =>
  String(value)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

const SHIPPING_RATES = {
  "arica y parinacota": { XS: 7150, S: 8300, M: 12400, L: 17000, XL: 25000 },
  tarapaca: { XS: 6550, S: 7400, M: 10700, L: 15500, XL: 23000 },
  antofagasta: { XS: 6300, S: 7000, M: 9900, L: 14000, XL: 21000 },
  atacama: { XS: 4850, S: 5900, M: 7700, L: 9900, XL: 13800 },
  coquimbo: { XS: 4600, S: 5300, M: 7000, L: 9600, XL: 12800 },
  valparaiso: { XS: 3900, S: 4500, M: 6000, L: 7700, XL: 9700 },
  "metropolitana de santiago": {
    XS: 3100,
    S: 3650,
    M: 4700,
    L: 5700,
    XL: 7600,
  },
  "libertador general bernardo o higgins": {
    XS: 4000,
    S: 4800,
    M: 6400,
    L: 8300,
    XL: 11300,
  },
  maule: { XS: 4200, S: 5200, M: 6700, L: 8900, XL: 12100 },
  nuble: { XS: 4600, S: 5400, M: 7200, L: 9200, XL: 12600 },
  "bio-bio": { XS: 4700, S: 5700, M: 7300, L: 9500, XL: 12800 },
  araucania: { XS: 4950, S: 5900, M: 7700, L: 9900, XL: 13800 },
  "los rios": { XS: 5300, S: 6100, M: 8300, L: 10000, XL: 14200 },
  "los lagos": { XS: 5300, S: 6100, M: 8300, L: 10000, XL: 14200 },
  aysen: { XS: 8000, S: 9500, M: 14000, L: 21500, XL: 28500 },
  "magallanes y la antartica chilena": {
    XS: 8000,
    S: 9500,
    M: 14000,
    L: 21500,
    XL: 28500,
  },
};

const REGION_ALIASES = {
  "region metropolitana": "metropolitana de santiago",
  metropolitana: "metropolitana de santiago",
  rm: "metropolitana de santiago",
  "region de tarapaca": "tarapaca",
  "region de antofagasta": "antofagasta",
  "region de atacama": "atacama",
  "region de coquimbo": "coquimbo",
  "region de valparaiso": "valparaiso",
  "region del libertador general bernardo o higgins":
    "libertador general bernardo o higgins",
  ohiggins: "libertador general bernardo o higgins",
  "o higgins": "libertador general bernardo o higgins",
  "region del maule": "maule",
  "region de nuble": "nuble",
  "region del biobio": "bio-bio",
  biobio: "bio-bio",
  "bio bio": "bio-bio",
  "region de la araucania": "araucania",
  "region de los rios": "los rios",
  "region de los lagos": "los lagos",
  "region de aysen": "aysen",
  "aysen del general carlos ibanez del campo": "aysen",
  "region de magallanes y la antartica chilena":
    "magallanes y la antartica chilena",
  arica: "arica y parinacota",
};

export const resolveRegionKey = (region) => {
  const normalized = normalizeText(region);
  if (!normalized) return null;
  if (REGION_ALIASES[normalized]) return REGION_ALIASES[normalized];
  if (SHIPPING_RATES[normalized]) return normalized;
  return null;
};

const toGrams = (weight = {}) => {
  const value = Number(weight?.value || 0);
  const unit = String(weight?.unit || "g").toLowerCase();
  if (unit === "kg") return Math.round(value * 1000);
  return Math.round(value);
};

export const getOrderTotalWeightGrams = (order) =>
  (order?.items || []).reduce((acc, item) => {
    const weightSrc =
      item.weight ||
      (item.product_id && typeof item.product_id === "object"
        ? item.product_id.weight
        : null) ||
      {};
    const unitWeight = toGrams(weightSrc);
    const quantity = Number(item.quantity || 0);
    return acc + unitWeight * quantity;
  }, 0);

export const getWeightTier = (grams) => {
  if (grams <= 500) return "XS"; // covers 0 and small items correctly
  if (grams <= 3000) return "S";
  if (grams <= 6000) return "M";
  if (grams <= 16000) return "L";
  if (grams <= 25000) return "XL";
  return null;
};

/* ------------------------ tarifa manual (Blue Express) ------------------- */

export const quoteManualShippingForOrder = (order) => {
  const regionKey = resolveRegionKey(order?.shipping?.region);
  if (!regionKey) {
    throw new BadRequestError(
      "La región ingresada no tiene tarifa configurada",
    );
  }

  const totalWeight = getOrderTotalWeightGrams(order);
  const tier = getWeightTier(totalWeight);

  if (!tier) {
    throw new BadRequestError(
      "El peso total supera el máximo permitido para tarifa manual",
    );
  }

  const regionRates = SHIPPING_RATES[regionKey];
  const amount = Number(regionRates?.[tier] || 0);

  if (!amount) {
    throw new BadRequestError(
      "No existe tarifa para esa región y rango de peso",
    );
  }

  return {
    services: [
      {
        id: `manual_${regionKey}_${tier}`,
        service_code: tier,
        service_name: `Blue Express manual ${tier}`,
        price: amount,
        amount,
        region: regionKey,
        weight_grams: totalWeight,
      },
    ],
    selected: {
      service_code: tier,
      service_name: `Blue Express manual ${tier}`,
      amount,
      carrier: "blueexpress_manual",
    },
    meta: {
      source: "manual_table",
      region: regionKey,
      weight_grams: totalWeight,
      weight_tier: tier,
    },
  };
};

/**
 * Punto único de cotización. Por ahora redirige a manual.
 * Cuando BlueExpress API esté integrado, decidir aquí.
 */
export const quoteShippingForOrder = (order) =>
  quoteManualShippingForOrder(order);

/* --------------------------- creación de envío --------------------------- */

/**
 * Crea el envío real una vez la orden está pagada.
 * Por defecto deja shipping en estado manual (pendiente de gestión).
 * Cuando BlueExpress API esté disponible, llamar al cliente acá.
 */
export const createShipmentForPaidOrder = async (order) => {
  if (!order) return null;

  if (env.BLUEEXPRESS_API_URL && env.BLUEEXPRESS_API_KEY) {
    // Stub: dejar punto de extensión documentado para la integración real.
    logger.info(
      { orderId: String(order._id) },
      "BlueExpress API configurada — integración real pendiente",
    );
  }

  if (!order.shipping?.shipment_status) {
    order.shipping = order.shipping || {};
    order.shipping.shipment_status = "pending_pickup";
    order.shipping.carrier = order.shipping.carrier || "blueexpress_manual";
    await order.save();
  }

  return order;
};
