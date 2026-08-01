/**
 * IDENTIDAD DE CIBOX — fuente de verdad ÚNICA.
 *
 * Todo lo que identifica a la empresa vive aquí: nombre, datos legales, giro,
 * contacto, dirección, colores y logo. Ningún otro archivo del backend debe
 * declarar una constante de marca; si la necesita, la importa de aquí.
 *
 * Los frontends NO duplican estos datos: los leen de `GET /api/config/brand`
 * (público, cacheado). La única excepción son los tokens de color, que el
 * bundler necesita en tiempo de build — viven en un solo archivo de tema por
 * app (`bodega/src/theme.js` y `tienda/src/constants/theme.js`) y deben
 * coincidir con `brand.colors`.
 *
 * Lo que puede cambiar sin tocar código (teléfono, correo, dirección, redes,
 * dominio) admite override por variable de entorno. Nada de esto es secreto.
 */

const env = (key, fallback) => {
  const v = process.env[key];
  return v == null || v === "" ? fallback : v;
};

export const brand = {
  // ── Identidad ──────────────────────────────────────────────────────────────
  name: env("BRAND_NAME", "Cibox"),
  tagline: env("BRAND_TAGLINE", "Tu supermercado online"),
  description: env(
    "BRAND_DESCRIPTION",
    "Supermercado 100% online: compra desde la web y te lo preparamos y despachamos.",
  ),

  // ── Datos legales (Chile) ──────────────────────────────────────────────────
  legal: {
    razon_social: env("BRAND_RAZON_SOCIAL", "CIBOX COMERCIALIZADORA SPA"),
    rut: env("BRAND_RUT", "78.245.061-1"),
    // Giro SII 471990 — "Venta al por menor en comercios no especializados
    // con predominio de alimentos, bebidas o tabaco (otros)".
    giro_codigo: env("BRAND_GIRO_CODIGO", "471990"),
    giro_glosa: env(
      "BRAND_GIRO_GLOSA",
      "Venta al por menor en comercios no especializados con predominio de alimentos, bebidas o tabaco",
    ),
    // IVA chileno. Los precios del catálogo se guardan CON IVA incluido.
    iva_pct: Number(env("BRAND_IVA_PCT", "19")),
    precios_con_iva: true,
  },

  // ── Contacto ───────────────────────────────────────────────────────────────
  contact: {
    email: env("BRAND_EMAIL", "contacto@cibox.cl"),
    email_soporte: env("BRAND_EMAIL_SOPORTE", "soporte@cibox.cl"),
    phone: env("BRAND_PHONE", "+56 9 3244 5772"),
    // Solo dígitos con código de país, para los enlaces wa.me.
    whatsapp: env("BRAND_WHATSAPP", "56932445772"),
    instagram: env("BRAND_INSTAGRAM", "cibox.cl"),
    tiktok: env("BRAND_TIKTOK", "cibox.cl"),
  },

  // ── Dirección de la bodega desde donde se prepara y despacha ──────────────
  address: {
    line1: env("BRAND_ADDRESS_LINE1", "Av. Lo Espejo 01565, Patio 6, Bodega 826"),
    line2: env("BRAND_ADDRESS_LINE2", "Centro Logístico Mersan"),
    comuna: env("BRAND_COMUNA", "Lo Espejo"),
    ciudad: env("BRAND_CIUDAD", "Santiago"),
    region: env("BRAND_REGION", "Región Metropolitana"),
    pais: env("BRAND_PAIS", "Chile"),
  },

  // ── Web ────────────────────────────────────────────────────────────────────
  web: {
    site_url: env("BRAND_SITE_URL", "https://cibox.cl"),
    // Esquema de deep-link de la app móvil (app.json de la tienda).
    app_scheme: env("BRAND_APP_SCHEME", "cibox"),
    // Prefijo de las claves de localStorage/sessionStorage de ambos frontends.
    storage_prefix: env("BRAND_STORAGE_PREFIX", "cibox"),
  },

  // ── Marca visual ───────────────────────────────────────────────────────────
  logo: {
    // Rutas relativas a los assets de cada app.
    panel: "/logo-cibox.png",
    tienda: "logo-cibox.png",
  },
  colors: {
    primary: "#4E9B27",       // verde Cibox — botones y CTA
    primaryLight: "#C3E062",  // lima — fondos destacados
    primaryDark: "#3B7A1D",   // verde profundo — énfasis, precios
    accent: "#F7B81C",        // amarillo — badges de descuento
    primaryText: "#ffffff",
    background: "#f7f8f5",
    surface: "#ffffff",
    text: "#111811",
    muted: "#5f6b5f",
    border: "#e3e8e0",
    ok: "#16794a",
    warn: "#d97706",
    danger: "#b00020",
    gradient: "linear-gradient(120deg,#3B7A1D 0%,#4E9B27 55%,#C3E062 100%)",
  },
};

/** Dirección en una línea (etiquetas, correos, página de contacto). */
export const addressOneLine = () => {
  const a = brand.address;
  return [a.line1, a.line2, a.comuna, a.ciudad].filter(Boolean).join(", ");
};

/**
 * Vista PÚBLICA de la marca (la que consumen los frontends por
 * GET /api/config/brand). Es el objeto completo: nada de lo que hay aquí es
 * secreto. Se expone como función para no dar una referencia mutable.
 */
export const publicBrand = () => ({
  name: brand.name,
  tagline: brand.tagline,
  description: brand.description,
  legal: { ...brand.legal },
  contact: { ...brand.contact },
  address: { ...brand.address, one_line: addressOneLine() },
  web: { ...brand.web },
  logo: { ...brand.logo },
  colors: { ...brand.colors },
});

export default brand;
