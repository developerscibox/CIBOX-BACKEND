// Agrupación por SECTOR físico de bodega (para boleta del vendedor y ticket de
// picking). Cada sector tiene un `orden` de recorrido configurable; la impresión
// sale en ese orden para minimizar desplazamientos del preparador. Lógica pura.

const SIN_SECTOR = "Sin sector";

/**
 * Agrupa ítems por sector y los ordena por la secuencia de recorrido.
 * @param {Array<{nombre,cantidad,precioUnit,sector?}>} items
 * @param {Object<string,number>} sectoresOrden  mapa nombre→orden de recorrido
 * @returns {Array<{sector,orden,items,subtotal}>} grupos ordenados por `orden`
 */
export function agruparPorSector(items = [], sectoresOrden = {}) {
  const map = new Map();
  for (const it of items) {
    const sector = (it.sector && String(it.sector).trim()) || SIN_SECTOR;
    if (!map.has(sector)) map.set(sector, []);
    map.get(sector).push(it);
  }
  const ordenDe = (s) => (s === SIN_SECTOR ? Infinity : sectoresOrden[s] ?? Infinity);
  return [...map.entries()]
    .map(([sector, its]) => ({
      sector,
      orden: ordenDe(sector),
      items: its,
      subtotal: its.reduce(
        (a, it) => a + (Number(it.cantidad) || 0) * (Number(it.precioUnit) || 0),
        0,
      ),
    }))
    .sort((a, b) => a.orden - b.orden || a.sector.localeCompare(b.sector, "es"));
}

export { SIN_SECTOR };
