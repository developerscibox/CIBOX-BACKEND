import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import { requireAdmin } from "../middlewares/roleMiddleware.js";
import {
  createCategorySchema,
  updateCategorySchema,
  listCategoriesSchema,
  categoryParamsSchema,
  categorySlugParamsSchema,
} from "../validators/categoryValidators.js";
import {
  listCategories,
  getCategoryById,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.js";

const router = Router();

// Públicos
router.get("/", validate({ query: listCategoriesSchema }), listCategories);
router.get("/slug/:slug", validate({ params: categorySlugParamsSchema }), getCategoryBySlug);
router.get("/:id", validate({ params: categoryParamsSchema }), getCategoryById);

// Admin
router.post(
  "/",
  protect,
  requireAdmin,
  validate({ body: createCategorySchema }),
  createCategory
);

router.patch(
  "/:id",
  protect,
  requireAdmin,
  validate({ params: categoryParamsSchema, body: updateCategorySchema }),
  updateCategory
);

router.delete(
  "/:id",
  protect,
  requireAdmin,
  validate({ params: categoryParamsSchema }),
  deleteCategory
);

export default router;
