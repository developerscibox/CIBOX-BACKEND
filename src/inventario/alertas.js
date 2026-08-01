/**
 * Alertas de stock — lógica pura (sin IO).
 *
 * Un supermercado no puede vender lo que no tiene, así que el sistema tiene que
 * avisar ANTES del quiebre. El nivel se calcula sobre el stock DISPONIBLE
 * (físico − reservado por carritos − comprometido a pedidos), no sobre el
 * físico: lo comprometido ya está vendido aunque siga en la estantería.
 */

/** Disponible real para vender: nunca negativo. */
export const disponibleDe = (p = {}) =>
  Math.max(
    0,
    Number(p.stock || 0) - Number(p.reserved || 0) - Number(p.allocated || 0),
  );

/**
 * Nivel de alerta de un producto.
 *
 *  - "quiebre"  → no queda nada disponible: no se puede vender.
 *  - "critico"  → disponible ≤ punto de reorden (min_stock). Hay que reponer ya.
 *  - "bajo"     → disponible ≤ 1,5 × min_stock, o ≤ `umbral` si el producto no
 *                 tiene punto de reorden definido. Conviene mirarlo.
 *  - "ok"       → nada que hacer.
 *
 * `min_stock = 0` significa que el producto NO participa de la reposición
 * automática (opt-in explícito); en ese caso solo aplica el umbral general.
 */
export const nivelDeStock = (p = {}, umbral = 10) => {
  const disponible = disponibleDe(p);
  if (disponible <= 0) return "quiebre";

  const min = Math.max(0, Number(p.min_stock || 0));
  if (min > 0) {
    if (disponible <= min) return "critico";
    if (disponible <= Math.ceil(min * 1.5)) return "bajo";
    return "ok";
  }
  return disponible <= Math.max(0, Number(umbral) || 0) ? "bajo" : "ok";
};

/** Orden de gravedad, para ordenar listados y decidir qué mostrar primero. */
export const GRAVEDAD = { quiebre: 0, critico: 1, bajo: 2, ok: 3 };

/** ¿Este nivel merece aparecer en las alertas del panel? */
export const esAlerta = (nivel) => nivel === "quiebre" || nivel === "critico" || nivel === "bajo";

/**
 * Resumen de una lista de productos para el tablero: cuántos hay en cada nivel.
 */
export const resumenAlertas = (productos = [], umbral = 10) => {
  const out = { quiebre: 0, critico: 0, bajo: 0, ok: 0, total: productos.length };
  for (const p of productos) out[nivelDeStock(p, umbral)] += 1;
  return out;
};

export default { disponibleDe, nivelDeStock, resumenAlertas, esAlerta, GRAVEDAD };
