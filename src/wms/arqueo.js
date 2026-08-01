// Arqueo de caja: compara el efectivo esperado (del cuadre Z) contra lo contado.
// Lógica pura testeable.

const round = (n) => Math.round(Number(n) || 0);

export function arqueoCaja(efectivoEsperado, efectivoContado) {
  const esperado = round(efectivoEsperado);
  const contado = round(efectivoContado);
  const diferencia = contado - esperado;
  return {
    esperado,
    contado,
    diferencia,
    estado: diferencia === 0 ? "cuadra" : diferencia > 0 ? "sobrante" : "faltante",
  };
}
