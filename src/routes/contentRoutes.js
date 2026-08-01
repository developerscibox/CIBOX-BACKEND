import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { boardLimiter } from "../middlewares/rateLimiters.js";
import {
  getHomeContent,
  putHomeContent,
  putHomeContentSchema,
  getModulesConfig,
  getBrandConfig,
  getStoreStatus,
  putStoreStatus,
  putStoreStatusSchema,
} from "../controllers/contentController.js";

const router = Router();

// Público: la home de la tienda lo pide en cada visita (cacheado 60s en el
// controller). boardLimiter porque comparte patrón de tablero público polleado.
router.get("/home", boardLimiter, getHomeContent);

// Edición desde el panel: mismo permiso que la gestión del catálogo.
router.put(
  "/home",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate(putHomeContentSchema),
  putHomeContent
);

// Pausa de la tienda online: estado público (la tienda lo pollea) + interruptor
// del panel (mismo permiso que el CMS de la portada).
router.get("/store-status", boardLimiter, getStoreStatus);
router.put(
  "/store-status",
  protect,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate(putStoreStatusSchema),
  putStoreStatus
);

// Router aparte para /api/config (switches de módulos comerciales).
export const configRouter = Router();
configRouter.get("/modules", boardLimiter, getModulesConfig);
configRouter.get("/brand", boardLimiter, getBrandConfig);

export default router;
