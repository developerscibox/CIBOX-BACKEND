import { asyncHandler } from "../middlewares/errorHandler.js";
import { Favorite } from "../models/Favorite.js";
import { Product } from "../models/Product.js";
import { NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const listMyFavorites = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Favorite.find({ user_id: userId })
      .populate({
        path: "product_id",
        select:
          "name thumbnail images pricing.min_price pricing.tiers is_active stock average_rating reviews_count vendor category brand",
      })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Favorite.countDocuments({ user_id: userId }),
  ]);

  return res.status(200).json({
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
  });
});

export const addFavorite = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId } = req.body;

  const product = await Product.findById(productId)
    .select("_id is_active")
    .lean();
  if (!product || product.is_active === false) {
    throw new NotFoundError("Producto no encontrado o inactivo");
  }

  const favorite = await Favorite.findOneAndUpdate(
    { user_id: userId, product_id: productId },
    { $setOnInsert: { user_id: userId, product_id: productId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  logger.info(
    { user_id: userId, product_id: String(productId) },
    "favorite.added"
  );

  return res.status(201).json({
    success: true,
    data: { favorite },
    message: "Producto agregado a favoritos",
  });
});

export const removeFavorite = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId } = req.params;

  const result = await Favorite.findOneAndDelete({
    user_id: userId,
    product_id: productId,
  }).lean();

  if (!result) throw new NotFoundError("Favorito no encontrado");

  logger.info(
    { user_id: userId, product_id: String(productId) },
    "favorite.removed"
  );

  return res.status(200).json({
    success: true,
    message: "Producto eliminado de favoritos",
  });
});

export const isFavorite = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId } = req.query;

  const exists = await Favorite.exists({
    user_id: userId,
    product_id: productId,
  });

  return res.status(200).json({
    success: true,
    data: { is_favorite: !!exists },
  });
});
