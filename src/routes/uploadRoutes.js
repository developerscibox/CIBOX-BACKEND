import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { upload } from "../middlewares/upload.js";
import {
  uploadSingle,
  uploadMultiple,
  deleteUpload,
} from "../controllers/uploadController.js";

const router = Router();

// Subir/borrar imágenes es gestión de catálogo: solo roles con products.manage
// (admin/gerente/vendor). Antes solo exigía estar logueado → cualquier customer podía
// subir o borrar cualquier asset de la cuenta Cloudinary.
router.post("/image", protect, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), upload.single("image"), uploadSingle);
router.post("/images", protect, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), upload.array("images", 10), uploadMultiple);
// wildcard: el key de Cloudinary trae carpeta con "/" (ej. cibox/products/<uuid>).
// En Express 5, ":key" solo matchea un segmento; "*key" captura la ruta completa.
router.delete("/*key", protect, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), deleteUpload);

export default router;

