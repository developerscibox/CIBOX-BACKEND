import { logger } from "../utils/logger.js";

/**
 * Keep-warm interno: evita el cold start (~50s) de Render plan free.
 *
 * Por qué interno y no solo el cron de GitHub: GitHub Actions throttlea los
 * crons `schedule` y en la práctica dispara cada 2-5 HORAS en vez de cada 10
 * min, mientras Render duerme el servicio a los ~15 min de inactividad. Eso
 * dejaba el backend dormido casi siempre → casi toda visita pagaba el cold
 * start. Este job hace que el propio servicio se auto-pingee cada ~13 min
 * (< 15), generando tráfico entrante que mantiene el instance despierto de
 * forma continua, sin cuenta externa ni costo.
 *
 * Render inyecta RENDER_EXTERNAL_URL automáticamente. En local (sin esa var)
 * el job no hace nada. Una vez despierto, el timer corre cada 13 min y la
 * cadena se mantiene viva indefinidamente.
 */

const INTERVAL_MS = Number(process.env.KEEP_WARM_INTERVAL_MS) || 13 * 60 * 1000; // 13 min
const REQUEST_TIMEOUT_MS = 30 * 1000;

export const startKeepWarmJob = () => {
  const base =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : null);

  // Sin URL pública (local/dev) o fetch no disponible → no-op.
  if (!base || typeof fetch !== "function") {
    return () => {};
  }

  const url = `${base.replace(/\/$/, "")}/health`;

  const ping = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      logger.debug({ url, status: res.status }, "keep-warm self-ping");
    } catch (err) {
      // Nunca tumbar el proceso por un ping fallido; el próximo reintenta.
      logger.warn({ url, err: err?.message }, "keep-warm self-ping falló");
    } finally {
      clearTimeout(t);
    }
  };

  const interval = setInterval(ping, INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  logger.info({ url, intervalMs: INTERVAL_MS }, "keep-warm interno activado");

  return () => clearInterval(interval);
};
