import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  ROLES,
  PERMISSIONS,
  roleHasPermission,
  MOVEMENT_TYPES,
  PAID_STATUSES,
} from "../utils/constants.js";

import Product from "../models/Product.js";
import Category from "../models/Category.js";
import Vendor from "../models/Vendor.js";
import { User } from "../models/User.js";
import StockMovement from "../models/StockMovement.js";
import Batch from "../models/Batch.js";
import Order from "../models/Order.js";
import { logMovement } from "../services/inventoryService.js";
import { getBoxQty } from "../services/pricingService.js";
import { importBulkRowSchema } from "../validators/productValidators.js";
import { normalizeText } from "../utils/text.js";
import { logAudit } from "../utils/audit.js";
import { cacheGet, cacheSet, cacheKey, cacheClearPrefix } from "../utils/responseCache.js";

// TTL de la caché del listado público de productos. Corto a propósito: la
// disponibilidad puede quedar un poco vieja, pero el add-to-cart re-valida
// atómicamente. Override por env si se quiere.
const PRODUCTS_CACHE_TTL_MS = Number(process.env.PRODUCTS_CACHE_TTL_MS) || 45 * 1000;
const PRODUCTS_CACHE_PREFIX = "products";

// Invalida toda la caché del catálogo público (tras crear/editar/activar/borrar).
const bustProductsCache = () => cacheClearPrefix(PRODUCTS_CACHE_PREFIX);

/**
 * Dado un array de IDs de categorías (strings o ObjectIds),
 * devuelve un Set con esos IDs más todos sus ancestros (padres, abuelos, etc.).
 * Hace queries iterativas hasta que no haya más parents que subir.
 */
const resolveAllCategoryIds = async (categoryIds) => {
  const allIds = new Set(categoryIds.map(String));
  let toResolve = [...allIds];

  while (toResolve.length > 0) {
    const cats = await Category.find(
      { _id: mongoose.trusted({ $in: toResolve }) },
    ).select("_id parent_id").lean();

    toResolve = [];
    for (const cat of cats) {
      if (cat.parent_id) {
        const parentStr = String(cat.parent_id);
        if (!allIds.has(parentStr)) {
          allIds.add(parentStr);
          toResolve.push(cat.parent_id);
        }
      }
    }
  }

  return Array.from(allIds);
};

/**
 * Recibe una lista de category IDs (los asignados explícitamente),
 * sube el árbol de padres y devuelve:
 *
 * - categories  → TODAS las categorías de la cadena: hijo + padres
 *                 Ejemplo: [{ Aceites y grasas }, { Despensa }]
 * - category    → la categoría hoja (la más específica, backward-compat)
 * - category_ids → IDs de todas (para filtrado rápido)
 *
 * Ejemplo resultado para un producto en "Aceites y grasas" (hijo de "Despensa"):
 *   categories:   [ { id: "...", name: "Aceites y grasas" }, { id: "...", name: "Despensa" } ]
 *   category:     { id: "...", name: "Aceites y grasas" }
 *   category_ids: [ "id-aceites", "id-despensa" ]
 */
const buildCategoriesPayload = async (categoryIds) => {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
    throw new BadRequestError("Debes asignar al menos una categoría al producto");
  }

  // Validar que las categorías explícitas existen
  const found = await Category.find(
    { _id: mongoose.trusted({ $in: categoryIds }), is_active: true },
  ).select("_id name parent_id").lean();

  if (found.length !== categoryIds.length) {
    throw new BadRequestError(
      "Una o más categorías no existen o están inactivas",
    );
  }

  // Resolver todos los IDs (explícitos + ancestros)
  const allIds = await resolveAllCategoryIds(found.map((c) => c._id));

  // Cargar los datos de TODAS las categorías de la cadena (para tener sus nombres)
  const allCats = await Category.find(
    { _id: mongoose.trusted({ $in: allIds }) },
  ).select("_id name parent_id").lean();

  // Ordenar: primero las hojas (sin hijos en el conjunto), luego los padres
  // Estrategia simple: los que tienen parent_id van primero (son más específicos)
  const allCatMap = new Map(allCats.map((c) => [String(c._id), c]));
  const childIds  = new Set(found.map((c) => String(c._id)));

  // Las hojas (asignadas explícitamente) van primero, luego sus ancestros
  const ordered = [
    ...allCats.filter((c) => childIds.has(String(c._id))),
    ...allCats.filter((c) => !childIds.has(String(c._id))),
  ];

  const categories   = ordered.map((c) => ({ id: String(c._id), name: c.name }));
  const category     = categories[0]; // la más específica, backward-compat
  const category_ids = allIds;

  return { categories, category, category_ids };
};

// Whitelists explícitas server-side (defensa en profundidad)
const VENDOR_UPDATE_FIELDS = new Set([
  "name",
  "description",
  // Precio de venta y formato. `pricing` (los tramos) ya NO se edita a mano:
  // el modelo lo deriva de estos campos.
  "price",
  "sale_unit",
  "unit_content",
  // Precio por unidad de medida (decreto 38/2024): solo las entradas; los
  // derivados los calcula el modelo y el validador rechaza que lleguen.
  "ppum",
  "pack_size",
  "pack_price",
  "tax",
  "category",
  "subcategory",
  "categories",
  "category_ids",
  "images",
  "thumbnail",
  // "stock" NO es editable por PUT: todo cambio de stock va por adjustStock /
  // receiveStock para que quede registrado en el kardex. El stock inicial sí se
  // fija al crear el producto (createProduct).
  // min_stock / target_stock SÍ son editables: son la regla de reposición, no
  // mueven inventario físico (no requieren kardex).
  "min_stock",
  "target_stock",
  "sku",
  "barcode",
  "brand",
  "compare_price",
  "weight",
  "dimensions",
  "box_items",
  "product_type",
  "cost_price",
  "expiry_date",
]);

const ADMIN_UPDATE_FIELDS = new Set([
  ...VENDOR_UPDATE_FIELDS,
  "is_active",
  "cibox_plus",
]);

const FORBIDDEN_FIELDS = new Set([
  "average_rating",
  "reviews_count",
  "vendor",
  "search_name",
  "_id",
  "created_at",
  "updated_at",
]);

const pickFields = (data, allowed) => {
  const out = {};
  for (const key of Object.keys(data)) {
    if (FORBIDDEN_FIELDS.has(key)) continue;
    if (allowed.has(key)) out[key] = data[key];
  }
  return out;
};

// cost_price es información sensible de margen: solo se expone a quien puede
// gestionar productos (products.manage → admin/gerente). Para el resto (tienda
// pública y vendors) se elimina de cada producto serializado. expiry_date sí
// es visible. Muta los .lean() en sitio para evitar copias.
const stripCostPriceForViewer = (req, items) => {
  if (roleHasPermission(req.user?.role, PERMISSIONS.PRODUCTS_MANAGE)) return items;
  const list = Array.isArray(items) ? items : [items];
  for (const p of list) {
    if (p && typeof p === "object") delete p.cost_price;
  }
  return items;
};

const buildSort = (sort) => {
  switch (sort) {
    case "price_asc":
      // pricing.min_price tiene índice y se mantiene en hooks (pre save/update)
      return { "pricing.min_price": 1, created_at: -1, _id: 1 };
    case "price_desc":
      return { "pricing.min_price": -1, created_at: -1, _id: 1 };
    case "newest":
      return { created_at: -1, _id: 1 };
    case "oldest":
      return { created_at: 1, _id: 1 };
    // El _id final es el desempate. Sin él, "Más vendidos" y "Mejor valorados"
    // ordenaban por campos que hoy valen 0 en los 763 productos: un empate
    // total, que Mongo resuelve distinto en cada página. Con scroll infinito
    // eso significaba productos repetidos y cerca de la mitad del catálogo
    // nunca visible.
    case "rating":
      return { average_rating: -1, reviews_count: -1, _id: 1 };
    case "popular":
      return { reviews_count: -1, average_rating: -1, _id: 1 };
    default:
      return { created_at: -1, _id: 1 };
  }
};

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildProductFilters = (q) => {
  const and = [];

  // include_inactive=true (solo admin/manager, gateado en la ruta) lista activos
  // e inactivos. Si se pasa is_active explícito, manda ese. Por defecto: activos.
  if (q.include_inactive === true || q.include_inactive === "true") {
    // sin filtro de is_active → devuelve todos
  } else if (q.is_active === undefined) {
    and.push({ is_active: true });
  } else {
    and.push({ is_active: q.is_active });
  }

  // in_stock=true → solo productos con stock físico.
  //
  // ANTES esto era un $expr que restaba `reserved` y `allocated` del stock. Era
  // más exacto en teoría y en producción devolvía 500 en TODAS las llamadas que
  // lo usaran, dejando la tienda sin un solo producto: un $expr dentro de $and
  // no sobrevive a `sanitizeFilter` ni envuelto en mongoose.trusted().
  //
  // Un filtro de catálogo no necesita esa precisión: `reserved` y `allocated`
  // son el inventario comprometido en pedidos sin despachar, y la validación
  // que de verdad impide vender de más corre en el carrito y el checkout contra
  // el disponible real. Aquí basta con no ofrecer lo que no existe en bodega, y
  // `stock` además está indexado.
  if (q.in_stock === true || q.in_stock === "true") {
    and.push({ stock: mongoose.trusted({ $gt: 0 }) });
  }

  // brand → coincidencia parcial case-insensitive por marca
  if (q.brand) {
    const raw = String(q.brand).trim();
    if (raw) {
      and.push({
        brand: mongoose.trusted({ $regex: escapeRegex(raw), $options: "i" }),
      });
    }
  }

  // Filtra por category_ids (incluye hijos y padres resueltos)
  // Mantiene fallback a "category.id" para productos legacy sin category_ids
  if (q.category) {
    and.push({
      $or: [
        { category_ids: q.category },
        { "category.id": q.category },
      ],
    });
  }
  if (q.subcategory) and.push({ "subcategory.id": q.subcategory });
  if (q.vendor) and.push({ "vendor.id": q.vendor });
  if (q.product_type) and.push({ product_type: q.product_type });

  if (q.min_price !== undefined || q.max_price !== undefined) {
    const range = {};

    if (q.min_price !== undefined && q.min_price !== "") {
      range.$gte = Number(q.min_price);
    }

    if (q.max_price !== undefined && q.max_price !== "") {
      range.$lte = Number(q.max_price);
    }

    if (Object.keys(range).length > 0) {
      // pricing.min_price tiene índice (is_active+min_price); tiers.0.price no.
      and.push({ "pricing.min_price": mongoose.trusted(range) });
    }
  }
  if (q.search) {
    const raw  = String(q.search).trim();
    if (raw) {
      // Búsqueda por regex sobre search_name (normalizado: sin tildes/mayúsculas).
      // NO se usa $text porque Mongoose lo bloquea con sanitizeFilter (global), aun
      // con trusted(). $regex vía trusted() sí pasa el sanitizer (como el de marca);
      // para este catálogo el escaneo es despreciable. El fallback multicampo
      // (buildRegexSearchFilters) cubre marca/categoría/descripción si no hay match.
      // Cada palabra por separado, todas deben aparecer, en cualquier orden.
      //
      // ANTES se armaba un solo regex con la frase completa, o sea exigía que
      // las palabras vinieran pegadas y en ese orden: buscar "leche colun" no
      // encontraba "Leche Natural Colun 1 L" y la tienda respondía "sin
      // resultados" en silencio. Buscar por varias palabras es justamente la
      // forma normal de buscar en un supermercado.
      const palabras = normalizeText(raw).split(/\s+/).filter(Boolean).slice(0, 8);
      for (const palabra of palabras) {
        and.push({ search_name: mongoose.trusted({ $regex: escapeRegex(palabra), $options: "i" }) });
      }
    }
  }

  return and.length ? { $and: and } : {};
}

// Fallback de búsqueda por regex multicampo cuando $text no devuelve resultados
// (coincidencias parciales / prefijos que el índice de texto no captura). Se usa
// solo si la búsqueda con $text vino vacía, para no pagar el collection scan
// salvo que sea necesario. Conserva la semántica anterior de buscar en varios
// campos no normalizados (brand, category.name, description).
const buildRegexSearchFilters = (q) => {
  const and = [];

  if (q.include_inactive === true || q.include_inactive === "true") {
    // todos
  } else if (q.is_active === undefined) {
    and.push({ is_active: true });
  } else {
    and.push({ is_active: q.is_active });
  }

  // Mismo criterio que el listado principal: stock físico, sin $expr (ver el
  // comentario largo allá arriba — el $expr devolvía 500 en producción).
  if (q.in_stock === true || q.in_stock === "true") {
    and.push({ stock: mongoose.trusted({ $gt: 0 }) });
  }

  if (q.brand) {
    const rawBrand = String(q.brand).trim();
    if (rawBrand) {
      and.push({
        brand: mongoose.trusted({ $regex: escapeRegex(rawBrand), $options: "i" }),
      });
    }
  }

  if (q.category) {
    and.push({
      $or: [{ category_ids: q.category }, { "category.id": q.category }],
    });
  }
  if (q.vendor) and.push({ "vendor.id": q.vendor });
  if (q.product_type) and.push({ product_type: q.product_type });

  if (q.min_price !== undefined || q.max_price !== undefined) {
    const range = {};
    if (q.min_price !== undefined && q.min_price !== "") {
      range.$gte = Number(q.min_price);
    }
    if (q.max_price !== undefined && q.max_price !== "") {
      range.$lte = Number(q.max_price);
    }
    if (Object.keys(range).length > 0) {
      and.push({ "pricing.min_price": mongoose.trusted(range) });
    }
  }

  const raw = String(q.search || "").trim();
  if (raw) {
    const normalized = normalizeText(raw);
    const normRegex = new RegExp(escapeRegex(normalized), "i");
    const rawRegex = new RegExp(escapeRegex(raw), "i");
    and.push({
      $or: [
        { search_name: normRegex },
        { name: rawRegex },
        { brand: rawRegex },
        { "category.name": rawRegex },
        { description: rawRegex },
      ],
    });
  }

  return and.length ? { $and: and } : {};
};

// Añade la proyección de disponibilidad (available = stock - reserved) a cada
// item .lean(). $ifNull-equivalente en JS: reserved puede no existir todavía.
const addAvailability = (items) => {
  const list = Array.isArray(items) ? items : [items];
  for (const p of list) {
    if (p && typeof p === "object") {
      const reserved = Number(p.reserved) || 0;
      const allocated = Number(p.allocated) || 0;
      p.available = Math.max(0, (Number(p.stock) || 0) - reserved - allocated);
    }
  }
  return items;
};;
const validateBoxItemsServer = async (items, currentProductId = null) => {
  if (!Array.isArray(items) || items.length < 2) {
    throw new BadRequestError("La caja debe incluir al menos 2 productos");
  }
  const ids = items.map((i) => String(i.product_id));
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new BadRequestError("box_items contiene productos duplicados");
  }
  if (currentProductId && unique.has(String(currentProductId))) {
    throw new BadRequestError("Una caja no puede incluirse a sí misma");
  }
  // Sin trusted, el $in sobre el path ObjectId tira CastError antes de
  // consultar: no se podía crear ni editar ningún producto de tipo caja.
  const products = await Product.find({
    _id: mongoose.trusted({ $in: ids }),
    is_active: true,
  })
    .select("_id product_type")
    .lean();
  if (products.length !== ids.length) {
    throw new BadRequestError(
      "Uno o más productos de la caja no existen o están inactivos",
    );
  }
  if (products.some((p) => p.product_type === "box")) {
    throw new BadRequestError(
      "No se permite incluir cajas dentro de otra caja",
    );
  }
};

const getVendorDisplayName = (vendor) =>
  vendor?.name ||
  vendor?.business_name ||
  vendor?.store_name ||
  vendor?.shop_name ||
  vendor?.company_name ||
  "Vendedor";

// Roles del WMS que gestionan el catálogo sin tener un vendor propio asociado
// (admin y gerente). Pueden indicar vendor.id explícito; si no, se asigna el
// primer vendor activo de la plataforma.
const CATALOG_MANAGER_ROLES = new Set([ROLES.ADMIN, ROLES.MANAGER]);

const resolveVendorForRequest = async (req) => {
  if (CATALOG_MANAGER_ROLES.has(req.user.role)) {
    if (req.body.vendor?.id) {
      const v = await Vendor.findById(req.body.vendor.id).lean();
      if (!v) throw new BadRequestError("Vendor no existe");

      return {
        id: String(v._id),
        name: getVendorDisplayName(v),
      };
    }

    // Sin vendor.id explícito: usar el primer vendor activo.
    const fallback = await Vendor.findOne({ is_active: true })
      .sort({ created_at: 1 })
      .lean();
    if (!fallback) {
      throw new BadRequestError(
        "No hay ningún vendor activo configurado para asignar el producto",
      );
    }

    return {
      id: String(fallback._id),
      name: getVendorDisplayName(fallback),
    };
  }

  const v = await Vendor.findOne({ user_id: req.user.id }).lean();

  if (!v) throw new ForbiddenError("Usuario no tiene vendor asociado");
  if (!v.is_active) throw new ForbiddenError("Vendor inactivo");

  return {
    id: String(v._id),
    name: getVendorDisplayName(v),
  };
};

export const createProduct = asyncHandler(async (req, res) => {
  const vendor = await resolveVendorForRequest(req);

  const productType = req.body.product_type || "simple";
  if (productType === "box") {
    await validateBoxItemsServer(req.body.box_items || []);
  }

  const search_name = normalizeText(req.body.name || "");

  // Resolver categorías — acepta array de IDs o una sola categoría legacy
  const rawCategoryIds =
    Array.isArray(req.body.category_ids) && req.body.category_ids.length
      ? req.body.category_ids
      : req.body.category?.id
        ? [req.body.category.id]
        : [];

  const catPayload = await buildCategoriesPayload(rawCategoryIds);

  const doc = await Product.create({
    ...req.body,
    product_type: productType,
    search_name,
    vendor,
    ...catPayload,          // category, categories, category_ids
    // La subcategoría explícita del body manda sobre la derivada del árbol.
    ...(req.body.subcategory ? { subcategory: req.body.subcategory } : {}),
  });

  bustProductsCache();
  logger.info(
    { product_id: String(doc._id), vendor_id: vendor.id, category_ids: catPayload.category_ids },
    "product created",
  );
  logAudit({ req, action: "producto.crear", target: doc.name, detail: "producto creado" });
  res
    .status(201)
    .json({ success: true, data: doc, message: "Producto creado" });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new NotFoundError("Producto no encontrado");

  let allowed;
  if (CATALOG_MANAGER_ROLES.has(req.user.role)) {
    // admin y gerente gestionan todo el catálogo (incl. is_active)
    allowed = ADMIN_UPDATE_FIELDS;
  } else if (req.user.role === ROLES.VENDOR) {
    const myVendor = await Vendor.findOne({ user_id: req.user.id })
      .select("_id")
      .lean();
    if (!myVendor) throw new ForbiddenError("Vendor no encontrado");
    if (String(product.vendor?.id) !== String(myVendor._id)) {
      throw new ForbiddenError("No puedes editar este producto");
    }
    allowed = VENDOR_UPDATE_FIELDS;
  } else {
    throw new ForbiddenError("Rol insuficiente");
  }

  const update = pickFields(req.body, allowed);

  if (update.name) {
    update.search_name = normalizeText(update.name);
  }

  // Si vienen categorías nuevas, recalcular todo el árbol
  const rawCategoryIds =
    Array.isArray(req.body.category_ids) && req.body.category_ids.length
      ? req.body.category_ids
      : null;

  if (rawCategoryIds) {
    const catPayload = await buildCategoriesPayload(rawCategoryIds);
    update.category     = catPayload.category;
    update.categories   = catPayload.categories;
    update.category_ids = catPayload.category_ids;
  }

  const finalType = update.product_type || product.product_type;
  if (finalType === "box") {
    const items =
      update.box_items !== undefined ? update.box_items : product.box_items;
    await validateBoxItemsServer(items, product._id);
  } else if (update.product_type === "simple") {
    update.box_items = [];
  }

  const updated = await Product.findByIdAndUpdate(product._id, update, {
    new: true,
    runValidators: true,
  }).lean();

  bustProductsCache();
  logger.info(
    { product_id: String(product._id), by: req.user.id },
    "product updated",
  );
  const cambios = [update.price !== undefined ? "precio" : null, update.cost_price !== undefined ? "costo" : null, update.name ? "nombre" : null].filter(Boolean).join(", ") || "datos";
  logAudit({ req, action: "producto.editar", target: updated?.name || product.name, detail: `actualizó ${cambios}` });
  res.json({ success: true, data: updated, message: "Producto actualizado" });
});

export const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new NotFoundError("Producto no encontrado");

  if (req.user.role !== ROLES.ADMIN) {
    const myVendor = await Vendor.findOne({ user_id: req.user.id })
      .select("_id")
      .lean();
    if (!myVendor || String(product.vendor?.id) !== String(myVendor._id)) {
      throw new ForbiddenError("No puedes eliminar este producto");
    }
  }

  product.is_active = false;
  await product.save();

  bustProductsCache();
  logger.info({ product_id: String(product._id) }, "product soft-deleted");
  res.json({ success: true, data: product, message: "Producto desactivado" });
});

export const toggleActive = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new NotFoundError("Producto no encontrado");
  product.is_active = !product.is_active;
  await product.save();
  bustProductsCache();
  logger.info(
    { product_id: String(product._id), is_active: product.is_active },
    "product toggled",
  );
  res.json({ success: true, data: product });
});

export const getProducts = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;

  // include_inactive solo para usuarios con permiso products.manage
  // (admin/manager). Para el resto se ignora → siguen viendo solo activos.
  const canManage = roleHasPermission(req.user?.role, PERMISSIONS.PRODUCTS_MANAGE);

  // Caché solo para peticiones ANÓNIMAS (el home y la tienda pública). Los
  // autenticados pueden ver include_inactive/cost_price → nunca se cachean.
  const cacheable = !req.user;
  const key = cacheable
    ? cacheKey(PRODUCTS_CACHE_PREFIX, {
        page,
        limit,
        sort: req.query.sort,
        category: req.query.category,
        brand: req.query.brand,
        in_stock: req.query.in_stock,
        vendor: req.query.vendor,
        product_type: req.query.product_type,
        min_price: req.query.min_price,
        max_price: req.query.max_price,
        search: req.query.search,
      })
    : null;

  if (key) {
    const cached = cacheGet(key);
    if (cached) return res.json(cached);
  }

  const queryForFilters =
    req.query.include_inactive && !canManage
      ? { ...req.query, include_inactive: undefined }
      : req.query;

  const sort = buildSort(req.query.sort);
  const skip = (page - 1) * limit;

  const { items, total } = await runProductQuery({
    query: queryForFilters,
    sort,
    skip,
    limit,
  });

  stripCostPriceForViewer(req, items);
  addAvailability(items);

  const payload = {
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page * limit < total,
        has_prev: page > 1,
      },
    },
  };

  if (key) cacheSet(key, payload, PRODUCTS_CACHE_TTL_MS);

  res.json(payload);
});

// Ejecuta el listado de productos: primero con $text (índice), y si hay término
// de búsqueda y $text no devuelve nada, reintenta con el fallback regex
// multicampo. Sin término de búsqueda, ejecuta una sola vez con los filtros base.
const runProductQuery = async ({ query, sort, skip, limit }) => {
  const filters = buildProductFilters(query);
  const hasSearch = String(query.search || "").trim().length > 0;

  const [items, total] = await Promise.all([
    Product.find(filters).sort(sort).skip(skip).limit(limit).lean(),
    Product.countDocuments(filters),
  ]);

  if (hasSearch && total === 0) {
    const regexFilters = buildRegexSearchFilters(query);
    const [fbItems, fbTotal] = await Promise.all([
      Product.find(regexFilters).sort(sort).skip(skip).limit(limit).lean(),
      Product.countDocuments(regexFilters),
    ]);
    return { items: fbItems, total: fbTotal };
  }

  return { items, total };
};

export const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).lean();

  if (!product) throw new NotFoundError("Producto no encontrado");

  stripCostPriceForViewer(req, product);
  addAvailability(product);

  if (product.product_type === "box" && Array.isArray(product.box_items)) {
    const ids = product.box_items
      .map((item) => item.product_id)
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));

    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));

    const boxProducts = await Product.find({
      _id: mongoose.trusted({ $in: objectIds }),
      is_active: true,
    })
      .select("_id name thumbnail images pricing brand")
      .lean();

    const productsMap = new Map(boxProducts.map((p) => [String(p._id), p]));

    product.box_items = product.box_items.map((item) => {
      const found = productsMap.get(String(item.product_id));

      return {
        ...item,
        product_id: found || item.product_id,
      };
    });
  }

  res.json({ success: true, data: product });
});

export const getProductsByVendor = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filters = { "vendor.id": req.params.vendorId, is_active: true };

  const [items, total] = await Promise.all([
    Product.find(filters)
      .sort({ created_at: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    Product.countDocuments(filters),
  ]);

  stripCostPriceForViewer(req, items);
  addAvailability(items);

  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page: p,
        limit: l,
        total,
        total_pages: Math.ceil(total / l),
      },
    },
  });
});

export const getProductsByCategory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filters = { "category.id": req.params.categoryId, is_active: true };

  const [items, total] = await Promise.all([
    Product.find(filters)
      .sort({ created_at: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    Product.countDocuments(filters),
  ]);

  stripCostPriceForViewer(req, items);
  addAvailability(items);

  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page: p,
        limit: l,
        total,
        total_pages: Math.ceil(total / l),
      },
    },
  });
});

export const searchProducts = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const sort = buildSort(req.query.sort);
  const skip = (page - 1) * limit;

  const { items, total } = await runProductQuery({
    query: req.query,
    sort,
    skip,
    limit,
  });

  stripCostPriceForViewer(req, items);
  addAvailability(items);

  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    },
  });
});
export const validateBoxItems = asyncHandler(async (req, res) => {
  await validateBoxItemsServer(req.body.items);
  res.json({ success: true, message: "Items válidos" });
});

// Recomendados sin N+1: consolida productIds y ejecuta una sola query
export const getRecommendedProductsForMe = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  if (!userId) {
    const fallback = await Product.find({
      is_active: true,
      product_type: "simple",
    })
      .sort({ average_rating: -1, reviews_count: -1, created_at: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: {
        based_on: "fallback_without_login",
        items: addAvailability(stripCostPriceForViewer(req, fallback)),
      },
    });
  }

  // Cargar modelos opcionales (pueden no existir en v2)
  let Favorite = null;
  let Pantry = null;
  let Order = null;
  try {
    Favorite = (await import("../models/Favorite.js")).default;
  } catch {
    Favorite = null;
  }
  try {
    Pantry = (await import("../models/Pantry.js")).default;
  } catch {
    Pantry = null;
  }
  try {
    Order = (await import("../models/Order.js")).default;
  } catch {
    Order = null;
  }

  const [favorites, pantry, orders] = await Promise.all([
    Favorite
      ? Favorite.find({ user_id: userId }).select("product_id").lean()
      : Promise.resolve([]),
    Pantry
      ? Pantry.findOne({ user_id: userId }).select("items.product_id").lean()
      : Promise.resolve(null),
    Order
      ? Order.find({ user_id: userId }).select("items.product_id").lean()
      : Promise.resolve([]),
  ]);

  const allIds = new Set();
  for (const f of favorites) {
    if (f.product_id) allIds.add(String(f.product_id));
  }
  if (pantry?.items?.length) {
    for (const it of pantry.items) {
      if (it.product_id) allIds.add(String(it.product_id));
    }
  }
  for (const o of orders) {
    for (const it of o.items || []) {
      if (it.product_id) allIds.add(String(it.product_id));
    }
  }

  // Una sola query para todos los productos referenciados
  const validIds = Array.from(allIds).filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );

  const objectIds = validIds.map((id) => new mongoose.Types.ObjectId(id));

  const referenced = objectIds.length
    ? await Product.find({
        _id: mongoose.trusted({ $in: objectIds }),
      })
        .select("_id category")
        .lean()
    : [];

  // Ponderar categorías en memoria
  const categoryCount = {};
  const excluded = new Set();
  for (const p of referenced) {
    if (p.category?.id) {
      categoryCount[p.category.id] = (categoryCount[p.category.id] || 0) + 1;
    }
    excluded.add(String(p._id));
  }

  const sortedCategories = Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);
  let recommended = [];
  if (sortedCategories.length) {
    recommended = await Product.find({
      is_active: true,
      "category.id": mongoose.trusted({ $in: sortedCategories }),
      _id: mongoose.trusted({
        $nin: Array.from(excluded).map((id) => new mongoose.Types.ObjectId(id)),
      }),
    })
      .sort({ average_rating: -1, reviews_count: -1, created_at: -1 })
      .limit(limit)
      .lean();
  }

  if (recommended.length < limit) {
    const fallback = await Product.find({
      is_active: true,
      _id: mongoose.trusted({
        $nin: [...excluded, ...recommended.map((r) => String(r._id))].map(
          (id) => new mongoose.Types.ObjectId(id),
        ),
      }),
    })
      .sort({ average_rating: -1, reviews_count: -1, created_at: -1 })
      .limit(limit - recommended.length)
      .lean();
    recommended = [...recommended, ...fallback];
  }

  res.json({
    success: true,
    data: {
      based_on: sortedCategories.length
        ? { favorite_categories: sortedCategories }
        : "fallback_top_rated",
      items: addAvailability(stripCostPriceForViewer(req, recommended)),
    },
  });
});

export const getVendorProducts = asyncHandler(async (req, res) => {
  const myVendor = await Vendor.findOne({ user_id: req.user.id })
    .select("_id name")
    .lean();

  if (!myVendor) throw new NotFoundError("Vendor no encontrado");

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const filters = {
    "vendor.id": String(myVendor._id),
  };

  if (req.query.is_active !== undefined) {
    filters.is_active =
      req.query.is_active === "true" || req.query.is_active === true;
  }

  const [items, total] = await Promise.all([
    Product.collection
      .find(filters)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),

    Product.collection.countDocuments(filters),
  ]);

  stripCostPriceForViewer(req, items);
  addAvailability(items);

  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    },
  });
});
export const getFeaturedProducts = async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 8));

  const items = await Product.find(
    mongoose.trusted({
      is_active: true,
      featured: true,
      // Stock físico. Este endpoint devolvía 500 en TODAS sus llamadas —con o
      // sin filtros— por el $expr que había aquí: con `sanitizeFilter` activo
      // (config/db.js) Mongoose lo rechaza aunque venga envuelto en trusted().
      // La home pedía destacados y no recibía ninguno.
      //
      // El operador va envuelto en su PROPIO trusted(), no basta con marcar el
      // objeto padre: Mongoose intenta castear { $gt: 0 } como si fuera el valor
      // literal de `stock` (un número) y responde "ID inválido para stock".
      stock: mongoose.trusted({ $gt: 0 }),
    }),
  )
    .sort({
      created_at: -1,
    })
    .limit(limit)
    .lean();

  stripCostPriceForViewer(req, items);
  addAvailability(items);

  return res.status(200).json({
    success: true,
    items,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Ficha técnica de producto (WMS) — GET /api/products/:id/ficha
// ─────────────────────────────────────────────────────────────────────────────

const FICHA_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Días calendario en Chile (TZ America/Santiago), formato YYYY-MM-DD.
const santiagoDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const toSantiagoDay = (date) => santiagoDayFmt.format(date);

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export const getProductFicha = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).lean();
  if (!product) throw new NotFoundError("Producto no encontrado");

  const now = new Date();

  // Serie de 30 días calendario (Santiago), de más antiguo a hoy. La aritmética
  // de días se hace en UTC puro sobre la fecha-label para no romper con DST.
  const todayLabel = toSantiagoDay(now);
  const [ty, tm, td] = todayLabel.split("-").map(Number);
  const todayUTC = Date.UTC(ty, tm - 1, td);
  const dayLabels = [];
  for (let i = FICHA_WINDOW_DAYS - 1; i >= 0; i--) {
    dayLabels.push(new Date(todayUTC - i * MS_PER_DAY).toISOString().slice(0, 10));
  }
  const daySet = new Set(dayLabels);

  // Margen de 1 día extra por el desfase UTC↔Santiago; el corte fino es por daySet.
  const since = new Date(now.getTime() - (FICHA_WINDOW_DAYS + 1) * MS_PER_DAY);

  const [movements, paidOrders, batches] = await Promise.all([
    // Kardex: ventas (type "venta", quantity negativo) del producto.
    StockMovement.find({
      product_id: product._id,
      type: MOVEMENT_TYPES.SALE,
      created_at: mongoose.trusted({ $gte: since }),
    })
      .select("quantity created_at")
      .lean(),
    // Monto vendido: órdenes pagadas con este producto (subtotal real cobrado).
    Order.find({
      status: mongoose.trusted({ $in: PAID_STATUSES }),
      paid_at: mongoose.trusted({ $gte: since }),
      "items.product_id": product._id,
    })
      .select("items.product_id items.subtotal paid_at")
      .lean(),
    Batch.find({ product_id: product._id, status: "open" })
      .sort({ received_at: 1 })
      .lean(),
  ]);

  // Unidades vendidas por día (días sin venta = 0).
  const unitsByDay = Object.fromEntries(dayLabels.map((d) => [d, 0]));
  for (const mv of movements) {
    const qty = Number(mv.quantity);
    if (qty >= 0) continue; // venta = salida (negativo); se ignora cualquier otro signo
    const label = toSantiagoDay(new Date(mv.created_at));
    if (daySet.has(label)) unitsByDay[label] += Math.abs(qty);
  }

  const serie_30d = dayLabels.map((dia) => ({ dia, unidades: unitsByDay[dia] }));
  const unidades_30d = serie_30d.reduce((s, r) => s + r.unidades, 0);
  const unidades_7d = serie_30d.slice(-7).reduce((s, r) => s + r.unidades, 0);

  let monto_30d = 0;
  for (const order of paidOrders) {
    if (!order.paid_at || !daySet.has(toSantiagoDay(new Date(order.paid_at)))) continue;
    for (const item of order.items || []) {
      if (String(item.product_id) === String(product._id)) {
        monto_30d += Number(item.subtotal || 0);
      }
    }
  }

  const por_dia = round2(unidades_30d / FICHA_WINDOW_DAYS);

  // Lotes abiertos con edad en bodega (días calendario Santiago).
  const lotes = batches.map((b) => {
    const recLabel = toSantiagoDay(new Date(b.received_at || b.created_at));
    const [ry, rm, rd] = recLabel.split("-").map(Number);
    const dias = Math.max(0, Math.round((todayUTC - Date.UTC(ry, rm - 1, rd)) / MS_PER_DAY));
    return {
      lot_code: b.lot_code || "",
      qty_remaining: Number(b.qty_remaining || 0),
      unit_cost: Number(b.unit_cost || 0),
      received_at: b.received_at || null,
      expiry_date: b.expiry_date || null,
      dias_en_bodega: dias,
    };
  });

  const totalLotQty = lotes.reduce((s, l) => s + l.qty_remaining, 0);
  const edad_prom_stock_dias =
    totalLotQty > 0
      ? round1(lotes.reduce((s, l) => s + l.dias_en_bodega * l.qty_remaining, 0) / totalLotQty)
      : null;

  const expiries = lotes
    .map((l) => l.expiry_date)
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b));
  const proxima_expiracion = expiries[0] || product.expiry_date || null;

  const stock = Number(product.stock || 0);
  const reserved = Number(product.reserved || 0);
  const allocated = Number(product.allocated || 0);
  const disponible = Math.max(0, stock - reserved - allocated);
  const cobertura_dias = por_dia > 0 ? round1(stock / por_dia) : null;

  const tiers = Array.isArray(product.pricing?.tiers) ? product.pricing.tiers : [];
  const tierUnidad = tiers.find((t) => Number(t.min_qty) === 1);
  const precio_venta =
    Number(product.pricing?.min_price) > 0
      ? Number(product.pricing.min_price)
      : Number(tierUnidad?.price || 0);
  const precio_compra = Number(product.cost_price || 0);
  const margen_bruto = precio_venta - precio_compra;
  const margen_pct = precio_venta > 0 ? round1((margen_bruto / precio_venta) * 100) : null;

  res.json({
    success: true,
    data: {
      producto: {
        _id: String(product._id),
        sku: product.sku || "",
        barcode: product.barcode || "",
        nombre: product.name,
        categoria: product.category?.name || "",
        imagen: product.thumbnail || product.images?.[0] || null,
        is_active: product.is_active !== false,
        precio_compra,
        precio_venta,
        box_qty: getBoxQty(tiers),
        margen_bruto,
        margen_pct,
      },
      ventas: {
        por_dia,
        por_semana: unidades_7d, // unidades de la ventana móvil de los últimos 7 días
        por_mes: unidades_30d,
        unidades_30d,
        monto_30d,
        serie_30d,
      },
      bodega: {
        stock,
        reserved,
        allocated,
        disponible,
        cobertura_dias,
        lotes,
        edad_prom_stock_dias,
        proxima_expiracion,
      },
      meta: {
        costeo: "costo promedio ponderado actual",
        nota: "ventas desde el kardex (type venta)",
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Importación masiva de SKUs — POST /api/products/import-bulk
// ─────────────────────────────────────────────────────────────────────────────

// Formato de venta de una fila del CSV. pack_size/pack_price son los nombres
// nuevos; box_qty/box_price se aceptan como alias por compatibilidad con las
// plantillas antiguas. Los tramos de precio los deriva el modelo.
// Datos del PPUM que el contenido del envase no alcanza a cubrir: metros por
// rollo (art. 11 n°5), peso drenado (art. 10), granel (art. 5°) y la marca de
// excepción del art. 8°. Todas las columnas son opcionales en la plantilla.
const importPpum = (row) => {
  const ppum = {};
  if (row.drained_value !== undefined) ppum.drained_value = Number(row.drained_value);
  if (row.pieces_per_pack !== undefined) ppum.pieces_per_pack = Number(row.pieces_per_pack);
  if (row.length_per_piece_m !== undefined) ppum.length_per_piece_m = Number(row.length_per_piece_m);
  if (row.bulk !== undefined) ppum.bulk = Boolean(row.bulk);
  if (row.ppum_exempt_reason) {
    ppum.mode = "exempt";
    ppum.exempt_reason = String(row.ppum_exempt_reason).trim();
  }
  return ppum;
};

const importSaleFormat = (row) => ({
  price: Number(row.price),
  sale_unit: row.sale_unit || "unidad",
  unit_content: {
    value: Number(row.content_value ?? 0),
    unit: String(row.content_unit ?? "").trim(),
  },
  ppum: importPpum(row),
  pack_size: Number(row.pack_size ?? row.box_qty ?? 0),
  pack_price: Number(row.pack_price ?? row.box_price ?? 0),
  tax: { afecto: row.iva_afecto !== false },
});

export const importBulkProducts = asyncHandler(async (req, res) => {
  const { rows, dry_run: dryRun = false } = req.body;

  // Mismo default de vendor que createProduct para admin/gerente
  // (sin vendor.id en el body → primer vendor activo).
  const vendor = await resolveVendorForRequest(req);
  const by = {
    user_id: req.user.id,
    role: req.user.role,
    label: req.user.name || req.user.email || "import",
  };

  // Cache de categorías por nombre normalizado (evita repetir queries por fila).
  const catCache = new Map();
  const resolveImportCategory = async (categoryName) => {
    const key = normalizeText(categoryName);
    if (catCache.has(key)) return catCache.get(key);
    const cat = await Category.findOne({
      name: mongoose.trusted({
        $regex: `^${escapeRegex(String(categoryName).trim())}$`,
        $options: "i",
      }),
      is_active: true,
    })
      .select("_id")
      .lean();
    const payload = cat ? await buildCategoriesPayload([String(cat._id)]) : null;
    catCache.set(key, payload);
    return payload;
  };

  // Fallback: categoría del primer producto activo (lazy, se calcula una vez).
  let fallbackCategory; // undefined = aún no calculado; null = no hay
  const getFallbackCategory = async () => {
    if (fallbackCategory !== undefined) return fallbackCategory;
    const ref = await Product.findOne({ is_active: true })
      .sort({ created_at: 1 })
      .select("category categories category_ids")
      .lean();
    fallbackCategory = ref?.category?.id
      ? {
          category: { id: ref.category.id, name: ref.category.name },
          categories: (ref.categories?.length ? ref.categories : [ref.category]).map(
            (c) => ({ id: c.id, name: c.name }),
          ),
          category_ids: ref.category_ids?.length ? ref.category_ids : [ref.category.id],
        }
      : null;
    return fallbackCategory;
  };

  // Dry-run: simula el match dentro del mismo archivo (una fila anterior que
  // "crearía" hace que la siguiente con el mismo código sea "actualizar").
  const pendingKeys = new Set();

  const resultados = [];
  let creados = 0;
  let actualizados = 0;
  let errores = 0;

  for (let i = 0; i < rows.length; i++) {
    const fila = i + 1;
    const raw = rows[i];
    // Identificadores para el reporte aun si la fila no valida.
    let sku = String(raw?.sku ?? "").trim();
    let barcode = String(raw?.barcode ?? "").trim();
    let name = String(raw?.name ?? "").trim();

    try {
      // Validación zod POR FILA: una fila mala no aborta el resto.
      const parsed = importBulkRowSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((iss) => `${iss.path.join(".") || "fila"}: ${iss.message}`).join("; "),
        );
      }
      const row = parsed.data;
      sku = row.sku || "";
      barcode = row.barcode || "";
      name = row.name;

      const notas = [];

      // MATCH: barcode primero, luego sku (solo si vienen con valor).
      let existing = null;
      if (barcode) existing = await Product.findOne({ barcode });
      if (!existing && sku) existing = await Product.findOne({ sku });

      const matchedInBatch =
        !existing &&
        dryRun &&
        ((barcode && pendingKeys.has(`barcode:${barcode}`)) ||
          (sku && pendingKeys.has(`sku:${sku}`)));

      if (existing || matchedInBatch) {
        // ── UPDATE: solo campos presentes; NUNCA tocar stock ────────────────
        if (matchedInBatch) {
          notas.push("coincide con una fila anterior del mismo archivo");
        }
        if (existing) {
          if (row.name !== undefined) existing.name = row.name; // pre-save renormaliza search_name
          if (row.brand !== undefined) existing.brand = row.brand;
          if (row.description !== undefined) existing.description = row.description;
          if (row.cost_price !== undefined) existing.cost_price = row.cost_price;
          if (row.min_stock !== undefined) existing.min_stock = row.min_stock;
          if (row.target_stock !== undefined) existing.target_stock = row.target_stock;
          if (row.sku) existing.sku = row.sku;
          if (row.barcode) existing.barcode = row.barcode;

          // Precio y formato de venta: solo lo que venga en la fila. Los tramos
          // de precio los regenera el pre-save del modelo.
          if (row.price !== undefined) existing.price = row.price;
          if (row.sale_unit !== undefined) existing.sale_unit = row.sale_unit;
          if (row.content_value !== undefined || row.content_unit !== undefined) {
            existing.unit_content = {
              value: Number(row.content_value ?? existing.unit_content?.value ?? 0),
              unit: String(row.content_unit ?? existing.unit_content?.unit ?? ""),
            };
          }
          const ppumRow = importPpum(row);
          if (Object.keys(ppumRow).length) {
            existing.ppum = { ...(existing.ppum?.toObject?.() ?? existing.ppum ?? {}), ...ppumRow };
          }
          const packSize = row.pack_size ?? row.box_qty;
          const packPrice = row.pack_price ?? row.box_price;
          if (packSize !== undefined) existing.pack_size = Number(packSize);
          if (packPrice !== undefined) existing.pack_price = Number(packPrice);
          if (row.iva_afecto !== undefined) {
            existing.tax = { ...(existing.tax || {}), afecto: row.iva_afecto };
          }

          if (row.category_name) {
            const catPayload = await resolveImportCategory(row.category_name);
            if (catPayload) {
              existing.category = catPayload.category;
              existing.categories = catPayload.categories;
              existing.category_ids = catPayload.category_ids;
            } else {
              notas.push(`categoría "${row.category_name}" no existe: se mantiene la actual`);
            }
          }

          if (row.subcategory_name) {
            const subPayload = await resolveImportCategory(row.subcategory_name);
            if (subPayload) existing.subcategory = subPayload.category;
            else notas.push(`subcategoría "${row.subcategory_name}" no existe: se mantiene la actual`);
          }

          if (row.stock_inicial !== undefined) {
            notas.push("stock_inicial ignorado (el stock de productos existentes no se toca)");
          }

          if (!dryRun) await existing.save();
        }

        actualizados += 1;
        resultados.push({
          fila,
          accion: "actualizar",
          sku,
          barcode,
          name,
          detalle: notas.join(" · ") || (dryRun ? "dry_run: se actualizaría" : "actualizado"),
        });
        continue;
      }

      // ── CREATE: requiere name (ya validado) y price > 0 ───────────────────
      if (row.price === undefined) {
        throw new BadRequestError("Crear producto nuevo requiere price > 0");
      }

      let catPayload = null;
      if (row.category_name) {
        catPayload = await resolveImportCategory(row.category_name);
        if (!catPayload) notas.push(`categoría "${row.category_name}" no existe`);
      }
      if (!catPayload) {
        catPayload = await getFallbackCategory();
        if (catPayload) {
          notas.push(`se asignó la categoría por defecto "${catPayload.category.name}"`);
        } else {
          throw new BadRequestError(
            "Sin categoría: la indicada no existe y no hay productos activos de referencia",
          );
        }
      }

      let subPayload = null;
      if (row.subcategory_name) {
        subPayload = await resolveImportCategory(row.subcategory_name);
        if (!subPayload) notas.push(`subcategoría "${row.subcategory_name}" no existe`);
      }

      if (!row.description) notas.push("sin descripción: se usó el nombre");

      const stockInicial = Number(row.stock_inicial || 0);
      const payload = {
        name: row.name,
        search_name: normalizeText(row.name),
        description: row.description || row.name,
        ...importSaleFormat(row),
        ...catPayload, // category, categories, category_ids
        ...(subPayload ? { subcategory: subPayload.category } : {}),
        vendor,
        product_type: "simple",
        stock: stockInicial,
        sku,
        barcode,
        brand: row.brand || "",
        cost_price: row.cost_price ?? 0,
        min_stock: row.min_stock ?? 0,
        target_stock: row.target_stock ?? 0,
      };

      if (stockInicial > 0) {
        notas.push(`stock inicial ${stockInicial} un (kardex: recepcion)`);
      }

      if (!dryRun) {
        if (stockInicial > 0) {
          // Producto + movimiento de kardex en la MISMA transacción (fila atómica).
          const session = await mongoose.startSession();
          try {
            await session.withTransaction(async () => {
              const [doc] = await Product.create([payload], { session });
              await logMovement(
                {
                  productId: doc._id,
                  productName: doc.name,
                  type: MOVEMENT_TYPES.RECEIVING,
                  quantity: stockInicial,
                  stockAfter: doc.stock,
                  reason: "Importación masiva · stock inicial",
                  by,
                },
                session,
              );
            });
          } finally {
            await session.endSession();
          }
        } else {
          await Product.create(payload);
        }
      } else {
        if (barcode) pendingKeys.add(`barcode:${barcode}`);
        if (sku) pendingKeys.add(`sku:${sku}`);
      }

      creados += 1;
      resultados.push({
        fila,
        accion: "crear",
        sku,
        barcode,
        name,
        detalle: notas.join(" · ") || (dryRun ? "dry_run: se crearía" : "creado"),
      });
    } catch (err) {
      errores += 1;
      resultados.push({
        fila,
        accion: "error",
        sku,
        barcode,
        name,
        detalle: err?.message || "Error desconocido",
      });
    }
  }

  if (!dryRun && (creados > 0 || actualizados > 0)) bustProductsCache();

  logger.info(
    { total: rows.length, creados, actualizados, errores, dry_run: dryRun, by: by.label },
    "productos: importación masiva",
  );
  logAudit({
    req,
    action: "producto.importar",
    target: `${rows.length} filas`,
    detail: `${creados} creados, ${actualizados} actualizados, ${errores} errores${dryRun ? " (dry_run)" : ""}`,
  });

  res.json({
    success: true,
    data: {
      total: rows.length,
      creados,
      actualizados,
      errores,
      dry_run: dryRun,
      resultados,
    },
  });
});
