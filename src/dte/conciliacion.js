// Conciliación parallel-run: compara la salida de KSA+ contra el sistema anterior
// antes de apagar ningún módulo (regla: cero big-bang). Lógica pura testeable.
// Reporta documentos solo en uno u otro, y diferencias de monto.

/**
 * @param {Array} ksa
 * @param {Array} previo            documentos del sistema anterior
 * @param {(x:any)=>string} keyFn   clave del documento (ej. folio)
 * @param {(x:any)=>number} montoFn monto a comparar
 */
export function conciliar(ksa, previo, keyFn, montoFn) {
  const mapK = new Map(ksa.map((x) => [keyFn(x), x]));
  const mapL = new Map(previo.map((x) => [keyFn(x), x]));

  const soloEnKsa = [];
  const soloEnPrevio = [];
  const montoDistinto = [];

  for (const [k, x] of mapK) {
    if (!mapL.has(k)) soloEnKsa.push(k);
    else if (montoFn(x) !== montoFn(mapL.get(k))) {
      montoDistinto.push({ key: k, ksa: montoFn(x), previo: montoFn(mapL.get(k)) });
    }
  }
  for (const [k] of mapL) if (!mapK.has(k)) soloEnPrevio.push(k);

  const ok =
    soloEnKsa.length === 0 && soloEnPrevio.length === 0 && montoDistinto.length === 0;
  return { ok, soloEnKsa, soloEnPrevio, montoDistinto };
}
