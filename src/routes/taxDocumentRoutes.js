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
  markEmittedSchema,
} from "../validators/taxDocumentValidators.js";
import {
  emitForOrder,
  getMyDocuments,
  listAllDocuments,
  getDocumentById,
  voidDocument,
  markDocumentEmitted,
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

// Anotar a mano el folio de una boleta que ya se emitió en el portal del SII.
// Va después de GET "/:id" sin problema: distinto método y dos segmentos más.
router.post(
  "/admin/:id/emitida",
  protect,
  requireAdmin,
  validate({ params: taxDocumentIdParamsSchema, body: markEmittedSchema }),
  markDocumentEmitted
);

router.post(
  "/admin/void",
  protect,
  requireAdmin,
  validate({ body: voidDocumentSchema }),
  voidDocument
);

export default router;
