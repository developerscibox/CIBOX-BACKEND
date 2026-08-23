import { z } from "zod";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { SiteContent } from "../models/SiteContent.js";
import { env } from "../config/env.js";
import { publicBrand } from "../config/brand.js";
import { logger } from "../utils/logger.js";
import { cacheGet, cacheSet, cacheKey, cacheClearPrefix } from "../utils/responseCache.js";

// El GET del contenido es público y lo pide la home en cada visita → se
// cachea el payload armado (TTL corto) y se invalida al guardar desde el panel.
const CONTENT_CACHE_TTL_MS = 60 * 1000;
const CONTENT_CACHE_PREFIX = "content";
const bustContentCache = () => cacheClearPrefix(CONTENT_CACHE_PREFIX);

/**
 * SPECS: fuente única de verdad de los slots editables de la home.
 * El panel (bodega) las lee del GET para dibujar el formulario con ayudas
 * (tamaños recomendados, ratios, largos máximos) y el backend valida el PUT
 * con estos mismos máximos. Cambiar un max aquí cambia validación + UI.
 */
export const SPECS = {
  hero: {
    nombre: "Banner principal (hero)",
    descripcion:
      "Imagen grande de bienvenida con título, bajada y botón de acción. Es lo primero que ve el cliente.",
    // El hero se dibuja con aspectRatio 2 fijo (HomeScreen), igual en web que en
    // móvil: pedir un arte más apaisado hacía que 'cover' recortara ~37% del
    // ancho y se comiera el logo. La spec dice lo que el cliente realmente ve.
    tamano: "1600×800 px (2:1)",
    ratio_web: "2:1",
    ratio_movil: "2:1",
    campos: {
      title: { max: 60 },
      subtitle: { max: 120 },
      cta: { max: 25 },
      image_url: {},
    },
  },
  banner_1: {
    nombre: "Banner secundario 1",
    descripcion:
      "Franja promocional bajo el hero. Ideal para ofertas o liquidación. En celular se ve solo la mitad central de la imagen: pon lo importante al centro.",
    tamano: "1200×300 px",
    ratio_web: "4:1",
    ratio_movil: "2:1",
    campos: { title: { max: 50 }, image_url: {}, link: { max: 120 } },
  },
  banner_2: {
    nombre: "Banner secundario 2",
    descripcion:
      "Segunda franja promocional. Ideal para categorías destacadas. En celular se ve solo la mitad central de la imagen: pon lo importante al centro.",
    tamano: "1200×300 px",
    ratio_web: "4:1",
    ratio_movil: "2:1",
    campos: { title: { max: 50 }, image_url: {}, link: { max: 120 } },
  },
  banner_3: {
    nombre: "Banner secundario 3",
    descripcion:
      "Tercera franja promocional. Ideal para novedades o temporada. En celular se ve solo la mitad central de la imagen: pon lo importante al centro.",
    tamano: "1200×300 px",
    ratio_web: "4:1",
    ratio_movil: "2:1",
    campos: { title: { max: 50 }, image_url: {}, link: { max: 120 } },
  },
  cards: {
    nombre: "Tarjetas de la home",
    descripcion:
      "Hasta 6 tarjetas con ícono/imagen, título y bajada (beneficios, servicios, categorías).",
    tamano: "512×512 px (ícono/imagen)",
    ratio_web: "1:1",
    ratio_movil: "1:1",
    max_items: 6,
    campos: { title: { max: 35 }, subtitle: { max: 80 }, image_url: {} },
  },
  textos: {
    nombre: "Textos generales",
    descripcion: "Textos sueltos de la home: bienvenida y nota del pie de página.",
    campos: {
      welcome_title: { max: 70 },
      welcome_subtitle: { max: 140 },
      footer_note: { max: 200 },
    },
  },
};

// --- Validación del PUT (laxa: campos opcionales, maxes desde SPECS) ---

// url-ish: http(s), ruta relativa (/...) o data-uri de imagen. "" limpia el campo.
const imageUrlField = z
  .string()
  .trim()
  .max(500)
  .regex(/^$|^(https?:\/\/|\/|data:image\/)/, "URL de imagen inválida")
  .optional();

const textField = (max) => z.string().trim().max(max).optional();

const bannerSchema = z.object({
  title: textField(SPECS.banner_1.campos.title.max),
  image_url: imageUrlField,
  link: textField(SPECS.banner_1.campos.link.max),
});

const slotsSchema = z.object({
  hero: z
    .object({
      title: textField(SPECS.hero.campos.title.max),
      subtitle: textField(SPECS.hero.campos.subtitle.max),
      cta: textField(SPECS.hero.campos.cta.max),
      image_url: imageUrlField,
    })
    .optional(),
  banner_1: bannerSchema.optional(),
  banner_2: bannerSchema.optional(),
  banner_3: bannerSchema.optional(),
  cards: z
    .array(
      z.object({
        title: textField(SPECS.cards.campos.title.max),
        subtitle: textField(SPECS.cards.campos.subtitle.max),
        image_url: imageUrlField,
      })
    )
    .max(SPECS.cards.max_items, `Máximo ${SPECS.cards.max_items} tarjetas`)
    .optional(),
  textos: z
    .object({
      welcome_title: textField(SPECS.textos.campos.welcome_title.max),
      welcome_subtitle: textField(SPECS.textos.campos.welcome_subtitle.max),
      footer_note: textField(SPECS.textos.campos.footer_note.max),
    })
    .optional(),
});

export const putHomeContentSchema = {
  body: z.object({ slots: slotsSchema }),
};

// GET /api/content/home (público, cacheable 60s)
export const getHomeContent = asyncHandler(async (req, res) => {
  const key = cacheKey(CONTENT_CACHE_PREFIX, { key: "home" });
  const cached = cacheGet(key);
  if (cached) return res.status(200).json(cached);

  const doc = await SiteContent.findOne({ key: "home" }).lean();

  const payload = {
    success: true,
    data: {
      slots: doc?.slots ?? null,
      specs: SPECS,
      updated_at: doc?.updated_at ?? null,
    },
  };
  cacheSet(key, payload, CONTENT_CACHE_TTL_MS);
  return res.status(200).json(payload);
});

// PUT /api/content/home (protect + products.manage): upsert del singleton
export const putHomeContent = asyncHandler(async (req, res) => {
  const doc = await SiteContent.findOneAndUpdate(
    { key: "home" },
    {
      $set: {
        slots: req.body.slots,
        updated_by: {
          user_id: req.user.id,
          label: req.user.name || req.user.email || "admin",
        },
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  bustContentCache();
  logger.info({ key: "home", by: req.user.id }, "site_content.updated");

  return res.status(200).json({
    success: true,
    data: {
      slots: doc.slots,
      specs: SPECS,
      updated_at: doc.updated_at,
      updated_by: doc.updated_by,
    },
    message: "Contenido de la home guardado",
  });
});

// GET /api/config/modules (público): switches de módulos comerciales desde env
export const getModulesConfig = asyncHandler(async (req, res) => {
  return res.status(200).json({
    success: true,
    data: { enabled: env.modulesEnabled },
  });
});

// GET /api/config/brand — identidad de Cibox (público). Fuente de verdad:
// config/brand.js. Los frontends leen de aquí sus datos legales y de contacto
// en vez de repetirlos en su código.
export const getBrandConfig = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  return res.status(200).json({ success: true, data: publicBrand() });
});

// ── PAUSA DE LA TIENDA ONLINE (interruptor del panel) ────────────────────────
// Singleton SiteContent key "store": { paused, message }. La tienda lo consulta
// al abrir (y pollea) para mostrar la página de mantenimiento; el backend además
// bloquea el checkout mientras esté pausada (defensa en profundidad).
const STORE_STATUS_TTL_MS = 15 * 1000;

/** Estado actual (cacheado 15s). Reutilizable desde los controllers de checkout. */
export async function getStoreStatusData() {
  const key = cacheKey(CONTENT_CACHE_PREFIX, { key: "store-status" });
  const cached = cacheGet(key);
  if (cached) return cached;
  const doc = await SiteContent.findOne({ key: "store" }).lean();
  const data = {
    paused: !!doc?.slots?.paused,
    message: doc?.slots?.message || "",
    updated_at: doc?.updated_at ?? null,
  };
  cacheSet(key, data, STORE_STATUS_TTL_MS);
  return data;
}

// GET /api/content/store-status (público, cache 15s)
export const getStoreStatus = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await getStoreStatusData() });
});

export const putStoreStatusSchema = {
  body: z.object({
    paused: z.boolean(),
    message: z.string().trim().max(200).optional(),
  }),
};

// PUT /api/content/store-status (products.manage): pausa/reanuda la tienda online.
export const putStoreStatus = asyncHandler(async (req, res) => {
  const doc = await SiteContent.findOneAndUpdate(
    { key: "store" },
    {
      $set: {
        slots: { paused: req.body.paused, message: String(req.body.message || "").trim() },
        updated_by: { user_id: req.user.id, label: req.user.name || req.user.email || "admin" },
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  bustContentCache(); // invalida también el status cacheado (mismo prefijo)
  logger.info({ paused: !!doc.slots?.paused, by: req.user.id }, "store_status.updated");
  return res.status(200).json({
    success: true,
    data: { paused: !!doc.slots?.paused, message: doc.slots?.message || "", updated_at: doc.updated_at },
    message: doc.slots?.paused ? "Tienda online PAUSADA" : "Tienda online reactivada",
  });
});
