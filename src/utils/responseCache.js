/**
 * Caché en memoria con TTL para respuestas públicas (catálogo y categorías).
 *
 * Por qué: en plan free (Render CPU throttled + Atlas M0) cada GET /products
 * vuelve a correr find+count y a serializar ~40 docs, dando ~0.65s de TTFB
 * tibio. El home pide SIEMPRE los mismos params (page=1&limit=...), así que
 * cachear el payload ya armado convierte los hits en ~0.1s (solo red).
 *
 * Coherencia: el backend corre como UN solo instance en Render free, por lo
 * que esta caché en proceso es consistente. Las escrituras del catálogo
 * (crear/editar/activar producto o categoría) limpian el prefijo
 * correspondiente para reflejar el cambio de inmediato. La disponibilidad
 * (stock − reserved) puede quedar hasta `ttl` desactualizada en el listado,
 * pero el guard real anti-sobreventa es la reserva atómica en el add-to-cart
 * (no cacheada), así que no hay riesgo de vender de más.
 *
 * Solo se cachean peticiones ANÓNIMAS: las autenticadas (admin/gerente con
 * include_inactive/cost_price) nunca pasan por aquí.
 */

const store = new Map(); // key -> { value, expires }

const now = () => {
  // Date.now() es seguro en runtime normal del servidor.
  return Date.now();
};

/** Devuelve el valor cacheado si no expiró, o null. */
export const cacheGet = (key) => {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires <= now()) {
    store.delete(key);
    return null;
  }
  return hit.value;
};

/** Guarda un valor con TTL en ms. */
export const cacheSet = (key, value, ttlMs) => {
  store.set(key, { value, expires: now() + Number(ttlMs || 0) });
  return value;
};

/** Borra todas las entradas cuya key empieza con el prefijo dado. */
export const cacheClearPrefix = (prefix) => {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
};

/** Vacía toda la caché (uso en tests o reset manual). */
export const cacheClearAll = () => store.clear();

/**
 * Construye una key estable a partir de un objeto de params: ordena las claves
 * y omite las vacías/undefined para que `{a:1,b:2}` y `{b:2,a:1}` colisionen.
 */
export const cacheKey = (prefix, params = {}) => {
  const parts = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${String(params[k])}`);
  return `${prefix}:${parts.join("&")}`;
};

// Barrido periódico para no acumular keys expiradas (defensa de memoria).
// unref para no bloquear el cierre del proceso.
const sweep = setInterval(() => {
  const t = now();
  for (const [key, hit] of store.entries()) {
    if (hit.expires <= t) store.delete(key);
  }
}, 60 * 1000);
if (typeof sweep.unref === "function") sweep.unref();
