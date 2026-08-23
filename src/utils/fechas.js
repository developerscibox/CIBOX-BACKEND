/**
 * Fechas en hora de Chile.
 *
 * POR QUÉ EXISTE: el servidor corre con TZ=UTC y el negocio opera en
 * America/Santiago. Los reportes agrupan por día con `timezone: TZ` en la
 * agregación (o sea, días chilenos), pero las fechas y los límites de rango se
 * armaban con `new Date().toISOString().slice(0,10)` y
 * `new Date("YYYY-MM-DDT00:00:00.000")`, que son UTC y hora del proceso.
 *
 * Con 4 horas de diferencia eso significaba:
 *   - Desde las 20:00 de Chile, "Ventas del día" mostraba $0 y "−100% vs ayer",
 *     justo en las horas de mayor venta.
 *   - El periodo "Hoy" de Gerencia y Reportes se saltaba la tarde del último
 *     día y rotulaba la fecha de mañana.
 *   - El aging de cobranza marcaba morosos a clientes al día.
 *
 * Todo lo que compare fechas contra buckets agrupados en hora chilena debe
 * pasar por acá.
 */

export const TZ_CHILE = "America/Santiago";

/** "YYYY-MM-DD" del instante dado, en hora de Chile. ("en-CA" formatea así.) */
export const ymdChile = (fecha = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ_CHILE }).format(new Date(fecha));

/**
 * Offset de Chile en minutos para un instante dado (negativo al oeste de
 * Greenwich). Se calcula con Intl para respetar el horario de verano, que en
 * Chile cambia dos veces al año.
 */
const offsetChileMin = (fecha) => {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_CHILE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));
  // El hour24 de Intl puede venir como "24" a medianoche en algunos runtimes.
  const hora = Number(p.hour) % 24;
  const comoSiFueraUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hora,
    Number(p.minute),
    Number(p.second),
  );
  // Redondeado a minutos enteros: formatToParts no devuelve milisegundos, así
  // que para un instante como 23:59:59.999 la resta arrastra un desfase de casi
  // un segundo. Los offsets de zona horaria son siempre múltiplos de minuto, de
  // modo que redondear es exacto y elimina el arrastre.
  return Math.round((comoSiFueraUTC - new Date(fecha).getTime()) / 60000);
};

/** Instante UTC en que empieza el día "YYYY-MM-DD" en Chile (00:00:00.000). */
export const inicioDiaChile = (ymd) => {
  const aprox = new Date(`${ymd}T00:00:00.000Z`);
  return new Date(aprox.getTime() - offsetChileMin(aprox) * 60000);
};

/** Instante UTC en que termina el día "YYYY-MM-DD" en Chile (23:59:59.999). */
export const finDiaChile = (ymd) => {
  const aprox = new Date(`${ymd}T23:59:59.999Z`);
  return new Date(aprox.getTime() - offsetChileMin(aprox) * 60000);
};

/** "YYYY-MM-DD" de hace N días, en hora de Chile. */
export const ymdChileHaceDias = (dias, desde = new Date()) => {
  const d = new Date(desde);
  d.setUTCDate(d.getUTCDate() - Number(dias || 0));
  return ymdChile(d);
};

export default { TZ_CHILE, ymdChile, inicioDiaChile, finDiaChile, ymdChileHaceDias };
