/**
 * Precio por Unidad de Medida (PPUM) — lógica pura, sin IO.
 *
 * Implementa el decreto supremo N° 38 de 2024 del Ministerio de Economía
 * (publicado el 10-12-2024, vigente desde el 10-09-2025), que reemplazó al
 * decreto 229 de 2002 y baja el artículo 30 de la ley 19.496. Aplica a
 * plataformas de comercio electrónico, no solo a la sala de ventas.
 *
 * Reglas implementadas y de dónde salen:
 *  - Art. 4°  qué productos obligan a informar PPUM.
 *  - Art. 5°  a granel: el precio de venta ES el precio por unidad de medida.
 *  - Art. 6°  paquetes de unidades idénticas: se informa POR CADA UNIDAD.
 *  - Art. 7°  misma unidad de medida para cada tipo de producto (→ el preset se
 *             resuelve por categoría, nunca producto a producto).
 *  - Art. 8°  excepciones (aquí solo se MARCAN; ver `motivoExcepcion`).
 *  - Art. 9°  formato del texto: "$[precio] por [unidad de medida]".
 *  - Art. 10  basta el peso escurrido/drenado cuando el envase lo declara.
 *  - Art. 11  unidades preestablecidas para ciertas categorías.
 *
 * DECISIÓN PROPIA: el decreto NO regula redondeo ni decimales. Se redondea a
 * peso entero y se deja un decimal solo cuando el resultado baja de $10, para
 * que productos baratos por 10 g no colapsen todos a "$0 por 10 g".
 */

// ── Normalización de unidades ────────────────────────────────────────────────
// Cada tabla convierte a la unidad canónica de su magnitud (art. 3° n°8: masa
// en kilogramo, volumen en litro, área en metro cuadrado, longitud en metro).
const MASA = { mg: 0.000001, g: 0.001, gr: 0.001, grs: 0.001, gramo: 0.001, gramos: 0.001, kg: 1, kgs: 1, kilo: 1, kilos: 1 };
const VOLUMEN = { ml: 0.001, cc: 0.001, l: 1, lt: 1, lts: 1, litro: 1, litros: 1 };
const LONGITUD = { mm: 0.001, cm: 0.01, m: 1, mt: 1, mts: 1, metro: 1, metros: 1 };
const AREA = { cm2: 0.0001, "cm²": 0.0001, m2: 1, "m²": 1 };
const CONTEO = {
  un: 1, u: 1, uni: 1, unid: 1, unidad: 1, unidades: 1,
  pieza: 1, piezas: 1, pza: 1, pzas: 1,
  rollo: 1, rollos: 1, bolsita: 1, bolsitas: 1, sobre: 1, sobres: 1,
  huevo: 1, huevos: 1, docena: 12, docenas: 12,
};

const TABLAS = [
  ["masa", MASA],
  ["volumen", VOLUMEN],
  ["longitud", LONGITUD],
  ["area", AREA],
  ["conteo", CONTEO],
];

/** Limpia una unidad escrita a mano: "  Kg " → "kg", "ML" → "ml". */
const limpiarUnidad = (unidad) =>
  String(unidad ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

/**
 * Convierte una cantidad a su unidad canónica.
 * @returns {{magnitud: string, cantidad: number}|null} null si la unidad es
 *   desconocida o la cantidad no es positiva.
 */
export const normalizarCantidad = (valor, unidad) => {
  const cantidad = Number(valor);
  if (!(cantidad > 0)) return null;

  const u = limpiarUnidad(unidad);
  if (!u) return null;

  for (const [magnitud, tabla] of TABLAS) {
    const factor = tabla[u];
    if (factor !== undefined) return { magnitud, cantidad: cantidad * factor };
  }
  return null;
};

// ── Unidades preestablecidas (art. 11) ───────────────────────────────────────
// Cada preset declara, por magnitud, [cantidad de referencia en unidad canónica,
// etiqueta a mostrar]. La etiqueta es exactamente lo que ve el consumidor.
const BASE_POR_MAGNITUD = {
  masa: [1, "kg"],
  volumen: [1, "L"],
  longitud: [1, "m"],
  area: [1, "m²"],
  conteo: [1, "unidad"],
};

export const PRESETS = {
  // 1) Productos cosméticos, por 100 gramos o 100 mililitros.
  cosmeticos: { masa: [0.1, "100 g"], volumen: [0.1, "100 ml"] },
  // 2) Hierbas y especias, por 10 gramos.
  especias: { masa: [0.01, "10 g"] },
  // 3) Esencias aromáticas y colorantes alimentarios, por 10 mililitros.
  esencias: { volumen: [0.01, "10 ml"] },
  // 4) Salsa y caldo EN POLVO, por cada 10 gramos.
  salsa_polvo: { masa: [0.01, "10 g"] },
  // 5) Productos suministrados en rollo (papel higiénico), por metro.
  rollo: { longitud: [1, "m"] },
  // 6) Higiene y/o cuidado personal en paquetes de unidades idénticas, por unidad.
  higiene_pack: { conteo: [1, "unidad"] },
  // 7) Paquetes de 51 o más unidades, por cada 100 unidades.
  pack_51: { conteo: [100, "100 unidades"] },
  // 8) Huevos envasados, por unidad.
  huevos: { conteo: [1, "unidad"] },
};

/** Referencia [cantidad, etiqueta] para una magnitud bajo un preset dado. */
const referencia = (magnitud, preset) =>
  (preset && PRESETS[preset]?.[magnitud]) || BASE_POR_MAGNITUD[magnitud] || null;

// ── Cálculo ──────────────────────────────────────────────────────────────────

/**
 * Redondeo del PPUM. El decreto no lo regula: ver nota de cabecera.
 */
const redondear = (valor) =>
  valor < 10 ? Math.round(valor * 10) / 10 : Math.round(valor);

/** Formato del art. 9°: "$[precio] por [unidad de medida]". */
export const formatearPpum = (valor, etiqueta) =>
  `$${Number(valor).toLocaleString("es-CL")} por ${etiqueta}`;

/**
 * Calcula el precio por unidad de medida de UN producto.
 *
 * Devuelve `null` cuando no hay datos suficientes. Nunca devuelve un PPUM
 * parcial o inventado: si no se puede calcular bien, no se publica.
 *
 * @param {object} input
 * @param {number} input.precio            Precio de venta final, con IVA (art. 3° n°5).
 * @param {number} [input.contenido]       Contenido neto declarado del envase.
 * @param {string} [input.unidad]          Unidad de ese contenido ("g", "ml", "un"…).
 * @param {number} [input.contenidoDrenado] Peso escurrido/drenado (art. 10).
 * @param {number} [input.piezas]          Piezas idénticas dentro del envase (art. 6°).
 * @param {number} [input.largoPorPieza]   Metros por pieza; obligatorio en rollos (art. 11 n°5).
 * @param {boolean} [input.granel]         Producto vendido a granel (art. 5°).
 * @param {string} [input.preset]          Clave de PRESETS (art. 11).
 * @returns {{valor:number, etiqueta:string, magnitud:string, texto:string}|null}
 */
export const calcularPpum = ({
  precio,
  contenido,
  unidad,
  contenidoDrenado,
  piezas,
  largoPorPieza,
  granel = false,
  preset = "",
} = {}) => {
  const precioFinal = Number(precio);
  if (!(precioFinal > 0)) return null;

  // Art. 5°: a granel el precio de venta ya ES el precio por unidad de medida.
  // Solo hay que decir en qué unidad está expresado.
  if (granel) {
    const base = normalizarCantidad(1, unidad);
    if (!base) return null;
    const [, etiqueta] = referencia(base.magnitud, preset);
    return armar(precioFinal, etiqueta, base.magnitud);
  }

  const cantidad = magnitudTotal({ contenido, unidad, contenidoDrenado, piezas, largoPorPieza, preset });
  if (!cantidad) return null;

  const ref = referencia(cantidad.magnitud, preset);
  if (!ref) return null;

  const [porCantidad, etiqueta] = ref;
  const valor = (precioFinal / cantidad.cantidad) * porCantidad;
  if (!Number.isFinite(valor) || valor <= 0) return null;

  return armar(valor, etiqueta, cantidad.magnitud);
};

const armar = (valor, etiqueta, magnitud) => {
  const redondeado = redondear(valor);
  return { valor: redondeado, etiqueta, magnitud, texto: formatearPpum(redondeado, etiqueta) };
};

/**
 * Magnitud total del envase, en unidad canónica.
 *
 * El orden importa:
 *  1. Rollos con metraje conocido → longitud (art. 11 n°5).
 *  2. Peso escurrido cuando existe → art. 10 permite informarlo sobre el drenado.
 *  3. Contenido neto declarado.
 *  4. Piezas idénticas dentro del envase → conteo (arts. 4° b y 6°).
 */
const magnitudTotal = ({ contenido, unidad, contenidoDrenado, piezas, largoPorPieza, preset }) => {
  const nPiezas = Number(piezas) > 0 ? Number(piezas) : 0;
  const largo = Number(largoPorPieza) > 0 ? Number(largoPorPieza) : 0;

  // 1. Rollos: el art. 11 n°5 exige metro. Sin metraje NO se puede cumplir esa
  //    regla, así que se cae a "por unidad" (mejor que no informar nada), pero
  //    el llamador puede detectarlo comparando la magnitud contra "longitud".
  if (largo > 0) {
    const unidades = nPiezas || Number(contenido) || 1;
    return { magnitud: "longitud", cantidad: unidades * largo };
  }

  // 2. Art. 10: si el envase declara peso escurrido, basta informar sobre él.
  const drenado = normalizarCantidad(contenidoDrenado, unidad);
  if (drenado && drenado.magnitud === "masa") return drenado;

  // 3. Contenido neto declarado.
  const neto = normalizarCantidad(contenido, unidad);
  if (neto) {
    // Un contenido expresado en piezas ("12 un") ES el conteo del art. 6°.
    if (neto.magnitud === "conteo") return neto;
    return neto;
  }

  // 4. Sin contenido utilizable, quedan las piezas sueltas del envase.
  if (nPiezas > 0) return { magnitud: "conteo", cantidad: nPiezas };

  return null;
};

// ── Resolución del preset (art. 7° + art. 11) ────────────────────────────────

/**
 * Presets por categoría. El art. 7° obliga a usar la MISMA unidad para cada
 * tipo de producto, así que esto se resuelve por categoría y no producto a
 * producto: dos arroces de 900 g y 1 kg terminan ambos en "$ por kg".
 *
 * Las claves se comparan contra `category.name` y `subcategory.name`
 * normalizados (minúsculas, sin tildes).
 */
export const PRESET_POR_CATEGORIA = {
  "cuidado personal": "cosmeticos",
  "higiene personal": "cosmeticos",
  "belleza": "cosmeticos",
  "cosmetica": "cosmeticos",
};

/**
 * Reglas del art. 11 que cortan transversalmente las categorías y por lo tanto
 * se detectan por nombre de producto. El orden es el de precedencia.
 */
const REGLAS_POR_NOMBRE = [
  [/papel\s*higienico|toalla\s*de?\s*papel|papel\s*toalla|servitoalla/, "rollo"],
  [/\bpanal(es)?\b|toalla\s*(higienica|femenina)|protector\s*diario|aposito/, "higiene_pack"],
  [/\bhuevos?\b/, "huevos"],
  [/caldo\s*(en\s*polvo|deshidratado)|sopa\s*en\s*polvo|salsa\s*en\s*polvo/, "salsa_polvo"],
  [/colorante\s*(alimentario)?|esencia\s*(de|aromatica)/, "esencias"],
  [/\boregano\b|\bcomino\b|\bpaprika\b|\bcurcuma\b|\balbahaca\b|\bromero\b|\btomillo\b|\bpimienta\b|\bcanela\b|\bajo\s*en\s*polvo\b|especias?/, "especias"],
];

const sinTildes = (texto) =>
  String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/**
 * Determina qué unidad preestablecida corresponde a un producto.
 * Precedencia: regla explícita por nombre (art. 11) → categoría → n°7 (paquetes
 * de 51 o más unidades) → sin preset (unidad canónica de la magnitud).
 *
 * NOTA ABIERTA: un pack de 60 pañales cae a la vez en el n°6 ("por unidad") y
 * en el n°7 ("por cada 100 unidades"). El decreto no resuelve el conflicto;
 * aquí gana la regla específica del n°6.
 */
export const resolverPreset = ({ nombre, categoria, subcategoria, piezas } = {}) => {
  const texto = sinTildes(nombre);
  for (const [patron, preset] of REGLAS_POR_NOMBRE) {
    if (patron.test(texto)) return preset;
  }

  const porSub = PRESET_POR_CATEGORIA[sinTildes(subcategoria)];
  if (porSub) return porSub;

  const porCat = PRESET_POR_CATEGORIA[sinTildes(categoria)];
  if (porCat) return porCat;

  // Art. 11 n°7: paquetes de 51 o más unidades, por cada 100 unidades.
  if (Number(piezas) >= 51) return "pack_51";

  return "";
};

// ── Excepciones (art. 8°) ────────────────────────────────────────────────────

/**
 * Motivo por el que un producto NO está obligado a informar PPUM, o "" si sí
 * lo está. Se limita a lo que el catálogo puede saber por sí solo: el resto de
 * las excepciones (subasta, obras de arte, máquinas expendedoras, medicamentos,
 * comida preparada) se marcan a mano en la ficha.
 */
export const motivoExcepcion = ({ contenido, unidad, preset } = {}) => {
  // Art. 8° n°2: cantidades inferiores a 50 g o ml, salvo las del art. 11.
  if (preset) return "";
  const neto = normalizarCantidad(contenido, unidad);
  if (!neto) return "";
  if (neto.magnitud === "masa" && neto.cantidad < 0.05) return "menor_a_50";
  if (neto.magnitud === "volumen" && neto.cantidad < 0.05) return "menor_a_50";
  return "";
};

/**
 * Resuelve el PPUM de un documento de producto tal como vive en Mongo.
 * Es el punto único que usan el modelo (pre-save), las migraciones y el carrito.
 *
 * @param {object} producto        Documento de producto.
 * @param {number} [precioCobrado] Precio realmente cobrado, si difiere del de
 *                                 lista (descuento Cibox+, despensa, cupón).
 */
export const ppumDeProducto = (producto = {}, precioCobrado) => {
  const ppum = producto.ppum || {};

  if (ppum.mode === "exempt") return null;
  // Art. 8° n°1: las cajas Cibox son productos compuestos por unidades de
  // diferente naturaleza en un mismo envase. No corresponde informar PPUM.
  if (producto.product_type === "box") return null;

  // Ojo con `??`: el esquema defaultea estos campos a 0, no a undefined, así que
  // `ppum.net_value ?? unit_content.value` devolvía 0 y dejaba sin PPUM a todo
  // producto que ya tuviera el subdocumento guardado. El override solo manda
  // cuando de verdad trae un valor.
  const contenido = Number(ppum.net_value) > 0 ? Number(ppum.net_value) : (producto.unit_content?.value ?? 0);
  const unidad = ppum.net_unit || producto.unit_content?.unit || "";
  const piezas = Number(ppum.pieces_per_pack) > 0 ? Number(ppum.pieces_per_pack) : 0;

  const preset =
    ppum.preset ||
    resolverPreset({
      nombre: producto.name,
      categoria: producto.category?.name,
      subcategoria: producto.subcategory?.name,
      piezas: piezas || (normalizarCantidad(contenido, unidad)?.magnitud === "conteo" ? contenido : 0),
    });

  return calcularPpum({
    // Art. 3° n°6: el PPUM se calcula sobre el precio FINAL. Cuando el carrito
    // aplica un descuento, el PPUM tiene que moverse con él o miente.
    precio: precioCobrado ?? producto.price,
    contenido,
    unidad,
    contenidoDrenado: Number(ppum.drained_value) > 0 ? Number(ppum.drained_value) : 0,
    piezas,
    largoPorPieza: Number(ppum.length_per_piece_m) > 0 ? Number(ppum.length_per_piece_m) : 0,
    granel: Boolean(ppum.bulk),
    preset,
  });
};

export default {
  calcularPpum,
  formatearPpum,
  motivoExcepcion,
  normalizarCantidad,
  ppumDeProducto,
  PRESETS,
  PRESET_POR_CATEGORIA,
  resolverPreset,
};
