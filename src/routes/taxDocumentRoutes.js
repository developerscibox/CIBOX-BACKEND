import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import { requireAdmin, requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import {
  emitForOrderSchema,
  voidDocumentSchema,
  taxDocumentIdParamsSchema,
  listMyDocumentsSchema,
} from "../validators/taxDocumentValidators.js";
import {
  emitForOrder,
  getMyDocuments,
  listAllDocuments,
  getDocumentById,
  voidDocument,
} from "../controllers/taxDocumentController.js";

const router = Router();

// Listado read-only de documentos tributarios para el panel (admin + gerente).
router.get("/admin", protect, requirePermission(PERMISSIONS.REPORTS_READ), listAllDocuments);

router.post(
  "/emit",
  protect,
  requireAdmin,
  validate({ body: emitForOrderSchema }),
  emitForOrder
);

router.get("/me", protect, validate({ query: listMyDocumentsSchema }), getMyDocuments);

router.get(
  "/:id",
  protect,
  validate({ params: taxDocumentIdParamsSchema }),
  getDocumentById
);

router.post(
  "/admin/void",
  protect,
  requireAdmin,
  validate({ body: voidDocumentSchema }),
  voidDocument
);

export default router;
