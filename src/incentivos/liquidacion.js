// Liquidación de comisiones a partir del tablero de incentivos (lógica pura).
// totalPagar = comisión + bono por vendedor. Lista para exportar/pagar con los
// datos bancarios que ya guarda el vendedor.

export function liquidacionDesdeTablero(tablero) {
  return tablero.map((f) => ({
    vendedor: f.vendedor,
    comision: f.comision || 0,
    bono: f.bono || 0,
    totalPagar: (f.comision || 0) + (f.bono || 0),
  }));
}

export function totalLiquidacion(liq) {
  return liq.reduce((acc, r) => acc + r.totalPagar, 0);
}
