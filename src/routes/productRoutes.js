import { Router } from "express";
import { protect, optionalAuth } from "../middlewares/authMiddleware.js";
import {
  requireAdmin,
  requireVendor,
  requirePermission,
} from "../middlewares/roleMiddleware.js";
import { validate } from "../middlewares/validate.js";
import { ROLES, PERMISSIONS, roleHasPermission } from "../utils/constants.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

// Puede gestionar el catálogo: el vendor (sobre sus propios productos, control
// fino en el controller) o cualquier rol con products.manage (admin/manager).
const requireProductManager = (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  const ok =
    req.user.role === ROLES.VENDOR ||
    roleHasPermission(req.user.role, PERMISSIONS.PRODUCTS_MANAGE);
  if (!ok) return next(new ForbiddenError("Permiso insuficiente"));
  next();
};

import {
  createProductSchema,
  updateProductSchema,
  adminUpdateProductSchema,
  listProductsSchema,
  validateBoxItemsSchema,
  productIdParamSchema,
  vendorIdParamSchema,
  categoryIdParamSchema,
  importBulkSchema,
} from "../validators/productValidators.js";

import {
  createProduct,
  updateProduct,
  deleteProduct,
  toggleActive,
  getProducts,
  getProductById,
  getProductsByVendor,
  getProductsByCategory,
  searchProducts,
  validateBoxItems,
  getRecommendedProductsForMe,
  getVendorProducts,
  getFeaturedProducts,
  getProductFicha,
  importBulkProducts,
} from "../controllers/productController.js";
const router = Router();

// Rutas específicas primero
router.get("/recommended", optionalAuth, getRecommendedProductsForMe);
router.get("/mine", protect, requireVendor, getVendorProducts);

router.get("/search", validate({ query: listProductsSchema }), searchProducts);
router.get("/featured", getFeaturedProducts);

router.get(
  "/by-vendor/:vendorId",
  validate({ params: vendorIdParamSchema }),
  getProductsByVendor,
);

router.get(
  "/by-category/:categoryId",
  validate({ params: categoryIdParamSchema }),
  getProductsByCategory,
);

router.post(
  "/validate-box",
  validate({ body: validateBoxItemsSchema }),
  validateBoxItems,
);

// Importación masiva de SKUs (WMS). Ruta específica: SIEMPRE antes de /:id.
router.post(
  "/import-bulk",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ body: importBulkSchema }),
  importBulkProducts,
);

// Lista general. optionalAuth: permite que admin/manager autenticados usen
// include_inactive=true; el resto (invitados/clientes) solo ve productos activos.
router.get(
  "/",
  optionalAuth,
  validate({ query: listProductsSchema }),
  getProducts,
);

// Crear
router.post(
  "/",
  protect,
  requireProductManager,
  validate({ body: createProductSchema }),
  createProduct,
);

// Rutas dinámicas al final

// Ficha técnica (WMS): dos segmentos, no choca con GET /:id, pero se declara
// antes para mantener el orden específico→genérico del archivo.
router.get(
  "/:id/ficha",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ params: productIdParamSchema }),
  getProductFicha,
);

router.patch(
  "/:id",
  protect,
  requireProductManager,
  validate({ params: productIdParamSchema }),
  (req, res, next) => {
    // admin/manager (products.manage) usan el schema admin (permite is_active);
    // el vendor usa el schema restringido a sus campos.
    const isManager = roleHasPermission(req.user?.role, PERMISSIONS.PRODUCTS_MANAGE);
    const schema = isManager ? adminUpdateProductSchema : updateProductSchema;

    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  },
  updateProduct,
);

router.patch(
  "/:id/toggle-active",
  protect,
  requireAdmin,
  validate({ params: productIdParamSchema }),
  toggleActive,
);

router.delete(
  "/:id",
  protect,
  requireVendor,
  validate({ params: productIdParamSchema }),
  deleteProduct,
);

router.get("/:id", validate({ params: productIdParamSchema }), getProductById);

export default router;
