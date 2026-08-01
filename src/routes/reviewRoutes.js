import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect, requireEmailVerified } from "../middlewares/authMiddleware.js";
import { requireAdmin } from "../middlewares/roleMiddleware.js";
import {
  createReviewSchema,
  updateReviewSchema,
  moderateReviewSchema,
  reviewParamsSchema,
  productReviewsQuerySchema,
  productReviewsParamsSchema,
  adminReviewsQuerySchema,
} from "../validators/reviewValidators.js";
import {
  listProductReviews,
  getMyReview,
  createReview,
  updateReview,
  deleteReview,
  moderateReview,
  markHelpful,
  listAllReviewsAdmin,
} from "../controllers/reviewController.js";

const router = Router();

// Públicos
router.get(
  "/product/:productId",
  validate({ params: productReviewsParamsSchema, query: productReviewsQuerySchema }),
  listProductReviews
);

// Mi reseña para un producto (requiere auth)
router.get("/product/:productId/me", protect, getMyReview);

// Crear (requiere email verificado)
router.post(
  "/",
  protect,
  requireEmailVerified,
  validate({ body: createReviewSchema }),
  createReview
);

router.patch(
  "/:id",
  protect,
  validate({ params: reviewParamsSchema, body: updateReviewSchema }),
  updateReview
);

router.delete(
  "/:id",
  protect,
  validate({ params: reviewParamsSchema }),
  deleteReview
);

router.post(
  "/:id/helpful",
  protect,
  validate({ params: reviewParamsSchema }),
  markHelpful
);

// Admin
router.get(
  "/admin/all",
  protect,
  requireAdmin,
  validate({ query: adminReviewsQuerySchema }),
  listAllReviewsAdmin
);

router.post(
  "/:id/moderate",
  protect,
  requireAdmin,
  validate({ params: reviewParamsSchema, body: moderateReviewSchema }),
  moderateReview
);

export default router;
