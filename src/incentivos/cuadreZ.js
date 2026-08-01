// Cuadre de caja / cierre Z (lógica pura) a partir de las órdenes pagadas.
// Usa los datos de pago que la orden ya guarda (método, total) y el cajero.
// El endpoint solo agrupa órdenes de una fecha; el cálculo vive acá y es testeable.

const round = (n) => Math.round(Number(n) || 0);

// Normaliza la clave cruda del método de pago a una etiqueta estable que el
// frontend (CierreZ) sabe mapear (efectivo/transferencia/tarjeta).
const NORM_METODO = {
  cash_on_pickup: "efectivo",
  transfer: "transferencia",
  card: "tarjeta",
  efectivo: "efectivo",
  transferencia: "transferencia",
  tarjeta: "tarjeta",
  webpay: "Webpay",
  credito: "Crédito",
};

/**
 * @param {Array<{total:number, payment:{method:string}, cajero?:string}>} ordenesPagadas
 */
export function cuadreZ(ordenesPagadas) {
  const byMethod = {};
  const byCajero = {};
  let total = 0;
  let count = 0;

  for (const o of ordenesPagadas) {
    const monto = round(o.total);
    total += monto;
    count += 1;

    const raw = o.payment?.method || "desconocido";
    const metodo = NORM_METODO[raw] || raw;
    byMethod[metodo] = (byMethod[metodo] || 0) + monto;

    const cajero = o.cajero || "—";
    byCajero[cajero] = byCajero[cajero] || { cajero, total: 0, count: 0 };
    byCajero[cajero].total += monto;
    byCajero[cajero].count += 1;
  }

  return {
    total,
    count,
    byMethod,
    byCajero: Object.values(byCajero).sort((a, b) => b.total - a.total),
  };
}
