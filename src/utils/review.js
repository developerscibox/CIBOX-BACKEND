import mongoose from "mongoose";
import { Review } from "../models/Review.js";
import { Product } from "../models/Product.js";
import { logger } from "./logger.js";

/**
 * Recalcula average_rating y reviews_count del producto en base
 * a las reseñas aprobadas. No falla en silencio: registra errores.
 */
export const recalculateProductRating = async (productId) => {
  if (!productId) return null;

  try {
    const id = new mongoose.Types.ObjectId(String(productId));

    const [stats] = await Review.aggregate([
      { $match: { product_id: id, is_approved: true } },
      {
        $group: {
          _id: "$product_id",
          avg: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ]);

    const avg = stats?.avg ? Number(stats.avg.toFixed(1)) : 0;
    const count = stats?.count || 0;

    await Product.updateOne(
      { _id: id },
      { $set: { average_rating: avg, reviews_count: count } }
    );

    return { average_rating: avg, reviews_count: count };
  } catch (err) {
    logger.error(
      { err: { message: err.message }, productId: String(productId) },
      "review.recalculate_failed"
    );
    return null;
  }
};

export const generateSlug = (text) => {
  return String(text || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
};
