// Incentivo por TIEMPO de preparación (picking). Lógica PURA: sin modelos ni IO.
// El sistema ya mide los tiempos (status_history: preparing→ready); aquí solo se
// traduce ese tiempo a un premio en CLP según el tramo del pedido.
//
// TABLA DE METAS (TRAMOS) — valores por defecto acordados en reunión; el cliente
// entregará su tabla definitiva: EDITAR AQUÍ cuando llegue. Cada tramo define:
//   min_total / max_total → rango del total del pedido en CLP [min, max)
//   min_sku               → exige MÁS de esta cantidad de SKU (líneas del pedido)
//   meta_min              → minutos para preparar el pedido y ganar el premio completo
//   premio                → premio en CLP si cumple la meta
// Ej. del cliente: pedido de $1M+ con >10 SKU preparado en ≤40 min → $2.000.
export const TRAMOS = [
  { min_total: 0, max_total: 300_000, min_sku: 0, meta_min: 20, premio: 1000 },
  { min_total: 300_000, max_total: 1_000_000, min_sku: 0, meta_min: 30, premio: 1500 },
  { min_total: 1_000_000, max_total: Infinity, min_sku: 10, meta_min: 40, premio: 2000 },
];

/**
 * Premio por tiempo de un pedido preparado.
 * Dentro de la meta → premio completo. Sobre la meta, DECAE 25% del premio_full
 * por cada 10 min de exceso (proporcional) hasta llegar a 0. Redondeado a $100.
 *
 * @param {{total?:number, n_sku?:number, prep_min?:number|null}} p
 *   total: total del pedido (CLP); n_sku: nº de líneas (items.length);
 *   prep_min: minutos preparing→ready (null si no se midió).
 * @param {typeof TRAMOS} tramos tabla de metas (default: TRAMOS).
 * @returns {{tramo:number, meta_min:number, premio_full:number, premio:number}|null}
 *   null si ningún tramo matchea o falta el tiempo de preparación.
 */
export function premioPorTiempo({ total = 0, n_sku = 0, prep_min = null } = {}, tramos = TRAMOS) {
  const t = Number(total) || 0;
  const sku = Number(n_sku) || 0;
  // OJO: Number(null) === 0 — sin tiempo medido NO hay premio (null explícito).
  if (prep_min == null) return null;
  const min = Number(prep_min);
  if (!Number.isFinite(min) || min < 0) return null;

  const idx = tramos.findIndex(
    (tr) => t >= tr.min_total && t < tr.max_total && sku > tr.min_sku,
  );
  if (idx === -1) return null;

  const { meta_min, premio: premio_full } = tramos[idx];
  const sobre = Math.max(0, min - meta_min); // minutos sobre la meta
  const factor = Math.max(0, 1 - 0.25 * (sobre / 10)); // -25% por cada 10 min de exceso
  const premio = Math.round((premio_full * factor) / 100) * 100;
  return { tramo: idx + 1, meta_min, premio_full, premio };
}

export default { TRAMOS, premioPorTiempo };
