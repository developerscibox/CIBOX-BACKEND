// Plan de incentivos PILOTO (referencia, modificable). Puntos del vendedor por:
//  - cantidad de UNIDADES vendidas, y
//  - PLATA vendida ($).
// Lógica pura y trazable: cada punto sale de pedidos reales atribuidos al vendedor
// (etapa "toma" del relay). Configurable; estos son los valores por defecto.

export const DEFAULT_PILOTO = {
  puntosPorUnidad: 1,     // 1 punto por cada unidad vendida
  puntosPorMilCLP: 1,     // 1 punto por cada $1.000 vendidos
  // Bono opcional por superar una meta de venta en el periodo (0 = sin bono).
  bonoMetaCLP: 0,
  bonoPuntos: 0,
};

/**
 * Puntos de un vendedor según sus unidades y su venta en plata.
 * @param {{unidades:number, monto:number}} v
 * @param {typeof DEFAULT_PILOTO} cfg
 * @returns {{ptsUnidad:number, ptsMonto:number, ptsBono:number, total:number}}
 */
export function calcularPuntos({ unidades = 0, monto = 0 } = {}, cfg = DEFAULT_PILOTO) {
  const c = { ...DEFAULT_PILOTO, ...cfg };
  const ptsUnidad = Math.round((Number(unidades) || 0) * c.puntosPorUnidad);
  const ptsMonto = Math.round(((Number(monto) || 0) / 1000) * c.puntosPorMilCLP);
  const ptsBono = c.bonoMetaCLP > 0 && (Number(monto) || 0) >= c.bonoMetaCLP ? c.bonoPuntos : 0;
  return { ptsUnidad, ptsMonto, ptsBono, total: ptsUnidad + ptsMonto + ptsBono };
}

/**
 * Tablero piloto: cada vendedor con sus puntos, ordenado y rankeado.
 * @param {Array<{label:string, pedidos?:number, unidades:number, monto:number}>} vendedores
 */
export function rankingPiloto(vendedores = [], cfg = DEFAULT_PILOTO) {
  return vendedores
    .map((v) => ({ ...v, puntos: calcularPuntos(v, cfg) }))
    .sort((a, b) => b.puntos.total - a.puntos.total)
    .map((v, i) => ({ ...v, ranking: i + 1 }));
}
