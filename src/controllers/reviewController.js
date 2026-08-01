import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { Review } from "../models/Review.js";
import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { Vendor } from "../models/Vendor.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { PAID_STATUSES, ROLES } from "../utils/constants.js";
import { recalculateProductRating } from "../utils/review.js";
import {
  createNotification,
  createNotificationsForRole,
} from "../utils/notification.js";
import { logger } from "../utils/logger.js";

const buildSort = (sort) => {
  switch (sort) {
    case "helpful":
      return { helpful_count: -1, created_at: -1 };
    case "rating_desc":
      return { rating: -1, created_at: -1 };
    case "rating_asc":
      return { rating: 1, created_at: -1 };
    case "recent":
    default:
      return { created_at: -1 };
  }
};

export const listProductReviews = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = { product_id: productId, is_approved: true };
  if (req.query.rating) filter.rating = Number(req.query.rating);

  const [items, total, summary] = await Promise.all([
    Review.find(filter)
      .populate({ path: "user_id", select: "name" })
      .sort(buildSort(req.query.sort))
      .skip(skip)
      .limit(limit)
      .lean(),
    Review.countDocuments(filter),
    Review.aggregate([
      { $match: { product_id: filter.product_id, is_approved: true } },
      {
        $group: {
          _id: "$product_id",
          avg: { $avg: "$rating" },
          count: { $sum: 1 },
          stars_5: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
          stars_4: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
          stars_3: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
          stars_2: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
          stars_1: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
        },
      },
    ]),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      items,
      summary: summary[0]
        ? {
            average: Number((summary[0].avg || 0).toFixed(1)),
            count: summary[0].count,
            distribution: {
              5: summary[0].stars_5,
              4: summary[0].stars_4,
              3: summary[0].stars_3,
              2: summary[0].stars_2,
              1: summary[0].stars_1,
            },
          }
        : { average: 0, count: 0, distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } },
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
  });
});

export const createReview = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId, rating, title, comment, images, orderId } = req.body;

  const product = await Product.findById(productId);
  if (!product || product.is_active === false) {
    throw new NotFoundError("Producto no encontrado o inactivo");
  }

  const already = await Review.findOne({
    user_id: userId,
    product_id: productId,
  })
    .select("_id")
    .lean();
  if (already) {
    throw new ConflictError("Ya dejaste una reseña para este producto");
  }

  // Verifica compra real: orden pagada/posterior con el producto
  const purchaseFilter = {
    user_id: userId,
    "items.product_id": productId,
    status: mongoose.trusted({ $in: PAID_STATUSES }),
  };
  if (orderId) purchaseFilter._id = orderId;

  const purchase = await Order.findOne(purchaseFilter).select("_id").lean();
  if (!purchase) {
    throw new ForbiddenError(
      "Solo puedes reseñar productos que hayas comprado y cuya orden esté pagada"
    );
  }

  const review = await Review.create({
    user_id: userId,
    product_id: productId,
    order_id: purchase._id,
    rating,
    title: title || "",
    comment: comment || "",
    images: Array.isArray(images) ? images : [],
    is_verified_purchase: true,
    is_approved: false,
  });

  logger.info(
    { review_id: String(review._id), product_id: String(productId), user_id: userId },
    "review.created"
  );

  // Notificaciones (no bloqueantes)
  await createNotification({
    user_id: userId,
    type: "review_created",
    title: "Reseña enviada",
    body: `Tu reseña para ${product.name} fue enviada y está pendiente de moderación.`,
    data: { review_id: review._id, product_id: product._id, rating: review.rating },
  });

  await createNotificationsForRole({
    role: ROLES.ADMIN,
    type: "admin_new_review",
    title: "Nueva reseña pendiente de moderación",
    body: `Se creó una reseña para el producto ${product.name}.`,
    data: { review_id: review._id, product_id: product._id, rating: review.rating },
  });

  if (product.vendor?.id) {
    const vendor = await Vendor.findById(product.vendor.id).select("user_id").lean();
    if (vendor?.user_id) {
      await createNotification({
        user_id: vendor.user_id,
        type: "vendor_new_review",
        title: "Nueva reseña en tu producto",
        body: `Tu producto ${product.name} recibió una reseña.`,
        data: { review_id: review._id, product_id: product._id, rating: review.rating },
      });
    }
  }

  return res.status(201).json({
    success: true,
    data: { review },
    message: "Reseña creada. Pendiente de moderación.",
  });
});

export const updateReview = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const review = await Review.findById(req.params.id);
  if (!review) throw new NotFoundError("Reseña no encontrada");
  if (String(review.user_id) !== String(userId)) {
    throw new ForbiddenError("No autorizado para editar esta reseña");
  }

  const { rating, title, comment, images } = req.body;
  if (rating !== undefined) review.rating = rating;
  if (title !== undefined) review.title = title;
  if (comment !== undefined) review.comment = comment;
  if (images !== undefined) review.images = Array.isArray(images) ? images : [];

  // Cambiar contenido revierte aprobación: requiere nueva moderación
  review.is_approved = false;
  review.moderated_at = null;
  review.moderated_by = null;
  review.rejection_reason = null;

  await review.save();
  await recalculateProductRating(review.product_id);

  return res.status(200).json({
    success: true,
    data: { review: review.toObject() },
    message: "Reseña actualizada. Pendiente de re-moderación.",
  });
});

export const deleteReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.params.id);
  if (!review) throw new NotFoundError("Reseña no encontrada");

  const isOwner = String(review.user_id) === String(req.user.id);
  const isAdmin = req.user.role === ROLES.ADMIN;
  if (!isOwner && !isAdmin) {
    throw new ForbiddenError("No autorizado para eliminar esta reseña");
  }

  const productId = review.product_id;
  await review.deleteOne();
  await recalculateProductRating(productId);

  logger.info({ review_id: req.params.id, by: req.user.id }, "review.deleted");

  return res.status(200).json({
    success: true,
    message: "Reseña eliminada",
  });
});

export const moderateReview = asyncHandler(async (req, res) => {
  const { action, rejection_reason } = req.body;
  const review = await Review.findById(req.params.id);
  if (!review) throw new NotFoundError("Reseña no encontrada");

  if (action === "approve") {
    review.is_approved = true;
    review.rejection_reason = null;
  } else if (action === "reject") {
    review.is_approved = false;
    review.rejection_reason = rejection_reason || null;
  } else {
    throw new BadRequestError("Acción inválida");
  }

  review.moderated_at = new Date();
  review.moderated_by = req.user.id;
  await review.save();

  await recalculateProductRating(review.product_id);

  if (action === "approve") {
    await createNotification({
      user_id: review.user_id,
      type: "review_approved",
      title: "Tu reseña fue aprobada",
      body: "Tu reseña ahora es visible públicamente.",
      data: { review_id: review._id, product_id: review.product_id },
    });
  }

  logger.info(
    { review_id: req.params.id, action, by: req.user.id },
    "review.moderated"
  );

  return res.status(200).json({
    success: true,
    data: { review: review.toObject() },
    message: `Reseña ${action === "approve" ? "aprobada" : "rechazada"}`,
  });
});

export const markHelpful = asyncHandler(async (req, res) => {
  const review = await Review.findOneAndUpdate(
    { _id: req.params.id, is_approved: true },
    { $inc: { helpful_count: 1 } },
    { new: true }
  ).lean();

  if (!review) throw new NotFoundError("Reseña no encontrada o no aprobada");

  return res.status(200).json({
    success: true,
    data: { review },
    message: "Marcada como útil",
  });
});

export const getMyReview = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const review = await Review.findOne({
    product_id: productId,
    user_id: req.user.id,
  }).lean();

  if (!review) throw new NotFoundError("No tienes una reseña para este producto");

  return res.status(200).json({
    success: true,
    data: { review },
  });
});

export const listAllReviewsAdmin = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = {};
  switch (req.query.status) {
    case "approved":
      filter.is_approved = true;
      break;
    case "rejected":
      filter.is_approved = false;
      filter.moderated_at = { $ne: null };
      break;
    case "pending":
      filter.is_approved = false;
      filter.moderated_at = null;
      break;
    case "all":
    default:
      break;
  }
  if (req.query.productId) filter.product_id = req.query.productId;

  const [items, total] = await Promise.all([
    Review.find(filter)
      .populate({ path: "user_id", select: "name email" })
      .populate({ path: "product_id", select: "name thumbnail" })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Review.countDocuments(filter),
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
