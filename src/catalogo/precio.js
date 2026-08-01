/**
 * Lógica pura del precio del catálogo (sin IO).
 *
 * Cibox es un supermercado: cada producto tiene UN precio de venta al público,
 * con IVA incluido. El motor de precios heredado (carrito, despensa, checkout)
 * trabaja con tramos por cantidad (`pricing.tiers`), así que aquí se traduce
 * un precio de supermercado al formato de tramos que ese motor entiende.
 *
 * Contrato de `pricing.tiers` (ver services/pricingService.js): cada tramo
 * declara el precio POR UNIDAD a partir de `min_qty` unidades compradas.
 */

/**
 * Tramos derivados del precio de venta.
 * - Siempre existe el tramo de unidad.
 * - Si el producto se vende también por pack/caja (`packSize > 1`), se agrega su
 *   tramo con el precio unitario dentro del pack. Sin `packPrice`, el pack no
 *   tiene descuento (precio unitario × tamaño).
 */
export const buildTiers = ({ price, packSize, packPrice, saleUnit }) => {
  const unit = Math.max(0, Math.round(Number(price) || 0));
  const tiers = [{ min_qty: 1, price: unit, label: saleUnit || "unidad" }];

  const size = Math.max(0, Math.round(Number(packSize) || 0));
  if (size > 1) {
    const total = Math.max(0, Math.round(Number(packPrice) || 0)) || unit * size;
    tiers.push({ min_qty: size, price: Math.round(total / size), label: `pack de ${size}` });
  }
  return tiers;
};

/** Neto e IVA de un precio que YA incluye impuesto. */
export const desglosarIva = (precioConIva, ivaPct = 19, afecto = true) => {
  const total = Math.max(0, Math.round(Number(precioConIva) || 0));
  if (!afecto || !(Number(ivaPct) > 0)) return { neto: total, iva: 0 };
  const neto = Math.round(total / (1 + Number(ivaPct) / 100));
  return { neto, iva: total - neto };
};

export default { buildTiers, desglosarIva };
