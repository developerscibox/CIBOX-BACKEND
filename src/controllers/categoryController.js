import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { Category } from "../models/Category.js";
import { BadRequestError, NotFoundError, ConflictError } from "../utils/errors.js";
import { generateSlug } from "../utils/review.js";
import { logger } from "../utils/logger.js";
import { cacheGet, cacheSet, cacheKey, cacheClearPrefix } from "../utils/responseCache.js";

// Las categorías cambian poco → TTL más largo. El payload no depende del
// usuario (solo de los params), así que se cachea para todos.
const CATEGORIES_CACHE_TTL_MS = Number(process.env.CATEGORIES_CACHE_TTL_MS) || 5 * 60 * 1000;
const CATEGORIES_CACHE_PREFIX = "categories";
const bustCategoriesCache = () => cacheClearPrefix(CATEGORIES_CACHE_PREFIX);

const buildListFilter = (query) => {
  const filter = {};
  if (query.is_active === "true") filter.is_active = true;
  else if (query.is_active === "false") filter.is_active = false;
  else filter.is_active = true; // default público: solo activas

  if (query.is_featured === "true") filter.is_featured = true;
  if (query.is_featured === "false") filter.is_featured = false;

  if (query.parent_id === "null" || query.parent_id === "") {
    filter.parent_id = null;
  } else if (query.parent_id) {
    filter.parent_id = new mongoose.Types.ObjectId(query.parent_id);
  }

  if (query.search) {
    const safe = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.name = mongoose.trusted({ $regex: safe, $options: "i" });
  }

  return filter;
};

export const listCategories = asyncHandler(async (req, res) => {
  const key = cacheKey(CATEGORIES_CACHE_PREFIX, {
    tree: req.query.tree,
    page: req.query.page,
    limit: req.query.limit,
    parent_id: req.query.parent_id,
    is_active: req.query.is_active,
    is_featured: req.query.is_featured,
    search: req.query.search,
  });
  const cached = cacheGet(key);
  if (cached) return res.status(200).json(cached);

  // Modo árbol: devuelve padres + children
  if (req.query.tree === "true") {
    const all = await Category.find({ is_active: true })
      .sort({ sort_order: 1, name: 1 })
      .lean();

    const byParent = new Map();
    for (const cat of all) {
      const k = cat.parent_id ? String(cat.parent_id) : "root";
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(cat);
    }

    const buildTree = (parentKey) =>
      (byParent.get(parentKey) || []).map((cat) => ({
        ...cat,
        children: buildTree(String(cat._id)),
      }));

    const payload = {
      success: true,
      data: { categories: buildTree("root") },
    };
    cacheSet(key, payload, CATEGORIES_CACHE_TTL_MS);
    return res.status(200).json(payload);
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const filter = buildListFilter(req.query);

  const [items, total] = await Promise.all([
    Category.find(filter)
      .sort({ sort_order: 1, name: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Category.countDocuments(filter),
  ]);

  const payload = {
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
  };
  cacheSet(key, payload, CATEGORIES_CACHE_TTL_MS);
  return res.status(200).json(payload);
});

export const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id).lean();
  if (!category) throw new NotFoundError("Categoría no encontrada");

  return res.status(200).json({
    success: true,
    data: { category },
  });
});

export const getCategoryBySlug = asyncHandler(async (req, res) => {
  const category = await Category.findOne({ slug: req.params.slug }).lean();
  if (!category) throw new NotFoundError("Categoría no encontrada");

  return res.status(200).json({
    success: true,
    data: { category },
  });
});

export const createCategory = asyncHandler(async (req, res) => {
  const { name, slug, parent_id, ...rest } = req.body;

  if (parent_id) {
    const parent = await Category.findById(parent_id).select("_id").lean();
    if (!parent) throw new BadRequestError("La categoría padre no existe");
  }

  const finalSlug = slug ? slug : generateSlug(name);
  if (!finalSlug) throw new BadRequestError("No fue posible generar un slug válido");

  const existing = await Category.findOne({ slug: finalSlug }).select("_id").lean();
  if (existing) throw new ConflictError("Ya existe una categoría con ese slug");

  const category = await Category.create({
    name,
    slug: finalSlug,
    parent_id: parent_id || null,
    ...rest,
  });

  bustCategoriesCache();
  logger.info({ category_id: String(category._id), slug: finalSlug }, "category.created");

  return res.status(201).json({
    success: true,
    data: { category },
    message: "Categoría creada correctamente",
  });
});

export const updateCategory = asyncHandler(async (req, res) => {
  const updates = { ...req.body };

  if (updates.name && !updates.slug) {
    updates.slug = generateSlug(updates.name);
  }

  if (updates.parent_id) {
    if (String(updates.parent_id) === String(req.params.id)) {
      throw new BadRequestError("Una categoría no puede ser su propio padre");
    }
    const parent = await Category.findById(updates.parent_id).select("_id").lean();
    if (!parent) throw new BadRequestError("La categoría padre no existe");
  }

  if (updates.slug) {
    const dup = await Category.findOne({
      slug: updates.slug,
      _id: { $ne: req.params.id },
    })
      .select("_id")
      .lean();
    if (dup) throw new ConflictError("Ya existe otra categoría con ese slug");
  }

  const category = await Category.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  }).lean();

  if (!category) throw new NotFoundError("Categoría no encontrada");

  bustCategoriesCache();
  logger.info({ category_id: req.params.id }, "category.updated");

  return res.status(200).json({
    success: true,
    data: { category },
    message: "Categoría actualizada correctamente",
  });
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const hasChildren = await Category.exists({ parent_id: req.params.id });
  if (hasChildren) {
    throw new ConflictError("No se puede eliminar: tiene categorías hijas");
  }

  // Soft delete: marca como inactiva
  const category = await Category.findByIdAndUpdate(
    req.params.id,
    { is_active: false },
    { new: true }
  ).lean();

  if (!category) throw new NotFoundError("Categoría no encontrada");

  bustCategoriesCache();
  logger.info({ category_id: req.params.id }, "category.deactivated");

  return res.status(200).json({
    success: true,
    data: { category },
    message: "Categoría desactivada correctamente",
  });
});
