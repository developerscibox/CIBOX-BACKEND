/**
 * Cuánto stock mueve el despacho de un pedido — lógica pura (sin IO).
 *
 * Regla del inventario de Cibox, en tres estados:
 *
 *   1. El cliente confirma el pedido  → el stock se RESERVA (`allocated`).
 *      El físico NO baja: la mercadería sigue en la bodega.
 *   2. Se prepara y se despacha       → el físico SALE (`stock -= real`) y se
 *      libera lo reservado.
 *   3. Se cancela o se devuelve       → se repone lo que corresponda.
 *
 * El punto delicado es el FALTANTE: si al preparar aparecen menos unidades de
 * las esperadas, esas unidades ya se descontaron del físico al reportarlas
 * (ajuste de inventario con motivo). Si el despacho volviera a descontar la
 * cantidad esperada, el stock bajaría DOS VECES por la misma mercadería.
 *
 * Esta función responde exactamente eso: por cada ítem, cuánto sale del físico
 * y cuánto solo se libera de lo reservado.
 */

/**
 * @param {Array}  items      ítems del pedido: { product_id, quantity }
 * @param {Array}  faltantes  faltantes reportados: { product_id, qty_real }
 * @returns {Array} por ítem: { product_id, esperado, real, faltante }
 *   - `real`     → unidades que SALEN del físico ahora (commitPick).
 *   - `faltante` → unidades que solo se liberan de lo reservado: su físico ya
 *                  se descontó al reportar el faltante.
 */
export const planDeDespacho = (items = [], faltantes = []) => {
  const realPorProducto = new Map();
  for (const f of faltantes) {
    if (f?.product_id == null) continue;
    realPorProducto.set(String(f.product_id), Number(f.qty_real || 0));
  }

  const plan = [];
  for (const item of items) {
    if (!item?.product_id) continue;
    const pid = String(item.product_id);
    const esperado = Math.max(0, Number(item.quantity || 0));
    const real = realPorProducto.has(pid)
      ? Math.min(esperado, Math.max(0, realPorProducto.get(pid)))
      : esperado;
    plan.push({ product_id: pid, esperado, real, faltante: Math.max(0, esperado - real) });
  }
  return plan;
};

/**
 * Invariante que este módulo garantiza: por cada ítem, lo que sale del físico
 * más lo que se libera sin salir es EXACTAMENTE lo que se había reservado.
 * Ni una unidad de más (doble descuento) ni de menos (stock fantasma).
 */
export const cuadra = (plan = []) =>
  plan.every((p) => p.real + p.faltante === p.esperado);

export default { planDeDespacho, cuadra };
