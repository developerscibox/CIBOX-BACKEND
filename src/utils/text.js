/**
 * Normaliza texto para búsqueda insensible a tildes, mayúsculas y caracteres especiales.
 *
 * Ejemplos:
 *   "Café"       → "cafe"
 *   "ACEITE"     → "aceite"
 *   "Árbol"      → "arbol"
 *   "niño"       → "nino"
 *   "TRADIDIONAL" → "tradidional"
 */
export const normalizeText = (str) =>
  String(str ?? "")
    .normalize("NFD")                    // descompone é → e + ́
    .replace(/[̀-ͯ]/g, "")    // elimina los signos diacríticos
    .toLowerCase()
    .trim();
