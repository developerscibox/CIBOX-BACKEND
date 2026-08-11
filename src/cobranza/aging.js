// Cobranza / aging de cuentas por cobrar (lógica pura, testeable).
// Cibox vende a crédito → este es el dolor nº1. Reglas/cupos reales = defaults.
// Las fechas se pasan explícitas (YYYY-MM-DD) para que el cálculo sea determinista.

function diasEntre(desde, hasta) {
  const a = new Date(`${desde}T00:00:00Z`).getTime();
  const b = new Date(`${hasta}T00:00:00Z`).getTime();
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Aging de deudas por tramo de morosidad.
 * @param {Array<{cliente:string, documento:string, fecha_vencimiento:string, monto:number}>} deudas
 * @param {string} hoy  YYYY-MM-DD
 */
export function agingCuentasPorCobrar(deudas, hoy) {
  const buckets = { vigente: 0, "0-30": 0, "31-60": 0, "61-90": 0, "+90": 0 };
  let total = 0;
  for (const d of deudas) {
    const dias = diasEntre(d.fecha_vencimiento, hoy); // >0 = vencida hace N días
    const monto = Math.round(Number(d.monto) || 0);
    total += monto;
    if (dias <= 0) buckets.vigente += monto;
    else if (dias <= 30) buckets["0-30"] += monto;
    else if (dias <= 60) buckets["31-60"] += monto;
    else if (dias <= 90) buckets["61-90"] += monto;
    else buckets["+90"] += monto;
  }
  return { total, buckets };
}

/** A quién llamar hoy: vencidas, las más atrasadas/grandes primero. */
export function aQuienLlamarHoy(deudas, hoy) {
  return deudas
    .map((d) => ({ ...d, diasVencida: diasEntre(d.fecha_vencimiento, hoy) }))
    .filter((d) => d.diasVencida > 0)
    .sort((a, b) => b.diasVencida - a.diasVencida || b.monto - a.monto);
}

/** Cheques que vencen dentro de `dias` (alerta para depositar/cobrar a tiempo). */
export function chequesPorVencer(cheques, hoy, dias = 7) {
  return cheques
    .map((c) => ({ ...c, diasParaVencer: diasEntre(hoy, c.fecha_vencimiento) }))
    .filter((c) => c.diasParaVencer >= 0 && c.diasParaVencer <= dias)
    .sort((a, b) => a.diasParaVencer - b.diasParaVencer);
}
