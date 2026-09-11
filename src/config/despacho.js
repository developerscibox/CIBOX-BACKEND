/**
 * ZONA DE REPARTO Y TARIFA DE DESPACHO — fuente de verdad ÚNICA.
 *
 * Cibox despacha a domicilio y solo dentro de la zona de Rancagua. No hay
 * retiro en bodega. Este archivo es lo que el SERVIDOR usa para validar la zona
 * y para calcular el cobro, y se publica en `GET /api/config/despacho`.
 *
 *
 *   ▼▼▼  EL PRECIO DEL DESPACHO SE CAMBIA AQUÍ  ▼▼▼
 *
 *   TARIFA_PLANA_CLP — precio fijo por pedido, en pesos, igual para las cuatro
 *   comunas y sin depender del peso. El valor 3990 es PROVISORIO: el dueño
 *   todavía no fija el definitivo. Se puede cambiar de dos maneras:
 *     1. editando el número de abajo (requiere deploy), o
 *     2. seteando la variable de entorno DESPACHO_TARIFA_CLP en el servidor
 *        (toma efecto al reiniciar, sin tocar código).
 *   El cliente NUNCA manda el monto del despacho: el servidor lo calcula desde
 *   esta constante en cada cotización y al crear el pedido.
 *
 *   La vía 2 es la más peligrosa justamente porque NO requiere deploy: cambia
 *   lo que se cobra sin cambiar lo que se muestra. El arreglo de fondo es que
 *   la tienda consuma /api/config/despacho y borre su copia.
 *
 *   ENVIO_GRATIS_DESDE_CLP — desde este monto de mercadería el despacho no se
 *   cobra. Mismas dos vías (el número de abajo, o DESPACHO_ENVIO_GRATIS_CLP).
 *   Poner 0 apaga la promoción y vuelve a cobrarse siempre la tarifa plana.
 *
 *   ▲▲▲  EL PRECIO DEL DESPACHO SE CAMBIA AQUÍ  ▲▲▲
 */

const env = (key, fallback) => {
  const v = process.env[key];
  return v == null || v === "" ? fallback : v;
};

/** Tarifa plana por pedido dentro de la zona (CLP, entero). */
export const TARIFA_PLANA_CLP = Math.max(
  0,
  Math.round(Number(env("DESPACHO_TARIFA_CLP", "3990")) || 0),
);

/**
 * Monto de mercadería desde el cual el despacho sale gratis (CLP, entero).
 * 0 apaga la promoción.
 */
export const ENVIO_GRATIS_DESDE_CLP = Math.max(
  0,
  Math.round(Number(env("DESPACHO_ENVIO_GRATIS_CLP", "60000")) || 0),
);

/**
 * ¿Este pedido se lleva el despacho gratis?
 *
 * Se mide sobre el subtotal de la MERCADERÍA, antes de cualquier descuento de
 * cupón. La razón es de arquitectura, no de marketing: el despacho se cotiza en
 * seis caminos distintos (los cuatro endpoints de /api/shipping, la creación
 * desde el carrito y la del custom box) y cuatro de ellos no saben nada de
 * cupones. Midiendo antes del descuento, los seis dan el mismo número, así que
 * la vista previa del carrito y lo que Webpay cobra no se pueden separar nunca
 * —que es la única falla de verdad grave acá—. Medirlo después del cupón
 * arreglaría una fuga que hoy no existe (la base de producción tiene CERO
 * cupones) a cambio de meter esa separación.
 *
 * Si algún día se crean cupones grandes, la fuga es real: un 50% sobre un
 * carrito de 60.000 se lleva el despacho gratis pagando 30.000. Cuando eso pase,
 * el arreglo es exigir el mínimo sobre `subtotal - descuento` Y hacer que los
 * endpoints de cotización reciban el cupón, no solo lo primero.
 *
 * El `>=` es deliberado: quien llega justo a 60.000 esperando envío gratis y se
 * lo cobramos por un peso tiene razón en reclamar.
 */
export const hayEnvioGratis = (subtotalCLP) =>
  ENVIO_GRATIS_DESDE_CLP > 0 &&
  Math.round(Number(subtotalCLP) || 0) >= ENVIO_GRATIS_DESDE_CLP;

/** Lo que cuesta el despacho para un pedido de este subtotal. */
export const costoDespacho = (subtotalCLP) =>
  hayEnvioGratis(subtotalCLP) ? 0 : TARIFA_PLANA_CLP;

/** Nombre que ve el cliente en el detalle del pedido y en la boleta. */
export const NOMBRE_SERVICIO_DESPACHO = "Despacho zona Rancagua";

/** Etiqueta interna del transportista: el reparto lo hace Cibox, no un courier. */
export const CARRIER_DESPACHO = "cibox_reparto";

/** Única región con reparto. Es la región de las cuatro comunas de abajo. */
export const REGION_REPARTO =
  "Región del Libertador General Bernardo O'Higgins";

/**
 * Las ÚNICAS comunas donde se puede comprar. Escritas como el cliente las ve
 * (con tilde); la comparación se hace normalizada, así que da igual cómo las
 * escriba quien las manda.
 */
export const COMUNAS_CON_REPARTO = ["Rancagua", "Machalí", "Graneros", "Olivar"];

/* ------------------------------- comparación ------------------------------ */

// Comparamos "aplastando" el texto: en minúsculas y sin nada que no sea letra o
// número. El normalize("NFD") separa la tilde de su letra y el filtro se la
// lleva junto con espacios, puntos y apóstrofes. Así "Machalí", "MACHALI",
// "machali" y "  Machali  " son la misma comuna, y "O'Higgins", "O´Higgins" y
// "O Higgins" la misma región. Comparar con === es lo que rompe en producción:
// el nombre llega escrito distinto según de dónde venga.
const aplastar = (valor = "") =>
  String(valor)
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const COMUNAS_POR_CLAVE = new Map(
  COMUNAS_CON_REPARTO.map((c) => [aplastar(c), c]),
);

// Formas en que puede llegar escrita la Región de O'Higgins según de dónde
// venga el dato (selector de la tienda, dirección guardada, API, panel).
const REGIONES_EQUIVALENTES = new Set(
  [
    REGION_REPARTO,
    "Region del Libertador General Bernardo O'Higgins",
    "Libertador General Bernardo O'Higgins",
    "Libertador Bernardo O'Higgins",
    "Region de O'Higgins",
    "O'Higgins",
    "VI Region",
    "Region VI",
    "Sexta Region",
  ].map(aplastar),
);

/** Nombre canónico de la comuna si está en zona; null si no. */
export const comunaDeReparto = (comuna) =>
  COMUNAS_POR_CLAVE.get(aplastar(comuna)) || null;

/** true si el texto de región corresponde a la región con reparto. */
export const esRegionDeReparto = (region) =>
  REGIONES_EQUIVALENTES.has(aplastar(region));

/** Mensaje único para el cliente. Nombra las comunas: no lo deja adivinando. */
export const MENSAJE_FUERA_DE_ZONA = `Por ahora solo despachamos en ${COMUNAS_CON_REPARTO.join(
  ", ",
)}. Todavía no llegamos a otras comunas.`;

/**
 * Decide si una dirección se puede despachar.
 *
 * Devuelve `{ ok: true, comuna, region }` con los nombres canónicos (para
 * guardarlos limpios), o `{ ok: false, campo, mensaje }` donde `campo` es el
 * nombre del campo del checkout que hay que pintar en rojo ("city" / "region").
 * La región se valida con manga ancha: si viene vacía la damos por buena y la
 * completamos, porque las cuatro comunas ya determinan la región sin ambigüedad.
 */
export const zonaDeDespacho = ({ region, comuna } = {}) => {
  if (!String(comuna || "").trim()) {
    return {
      ok: false,
      campo: "city",
      mensaje: "Necesitamos la comuna para calcular el despacho",
    };
  }

  const comunaCanonica = comunaDeReparto(comuna);
  if (!comunaCanonica) {
    return { ok: false, campo: "city", mensaje: MENSAJE_FUERA_DE_ZONA };
  }

  const regionTexto = String(region || "").trim();
  if (regionTexto && !esRegionDeReparto(regionTexto)) {
    return {
      ok: false,
      campo: "region",
      mensaje: `${comunaCanonica} pertenece a la ${REGION_REPARTO}`,
    };
  }

  return { ok: true, comuna: comunaCanonica, region: REGION_REPARTO };
};

/**
 * Vista PÚBLICA (la que consume la tienda por GET /api/config/despacho).
 * Nada de esto es secreto y evita que el frontend vuelva a hardcodear ni el
 * monto ni la lista de comunas.
 */
export const publicDespacho = () => ({
  tarifa_plana_clp: TARIFA_PLANA_CLP,
  envio_gratis_desde_clp: ENVIO_GRATIS_DESDE_CLP,
  nombre_servicio: NOMBRE_SERVICIO_DESPACHO,
  region: REGION_REPARTO,
  comunas: [...COMUNAS_CON_REPARTO],
  retiro_en_tienda: false,
  mensaje_fuera_de_zona: MENSAJE_FUERA_DE_ZONA,
});

export default {
  TARIFA_PLANA_CLP,
  ENVIO_GRATIS_DESDE_CLP,
  REGION_REPARTO,
  COMUNAS_CON_REPARTO,
};
