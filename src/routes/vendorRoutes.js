import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { requireAdmin, requireVendor } from "../middlewares/roleMiddleware.js";
import { validate } from "../middlewares/validate.js";
import {
  registerVendorSchema,
  updateMyVendorSchema,
  adminUpdateVendorSchema,
  listVendorsSchema,
  vendorIdParamSchema,
} from "../validators/vendorValidators.js";
import {
  registerVendor,
  getMyVendor,
  updateMyVendor,
  adminUpdateVendor,
  deactivateVendor,
  reactivateVendor,
  getPublicVendorById,
  listVendors,
} from "../controllers/vendorController.js";

const router = Router();

// Públicas
router.get("/", validate({ query: listVendorsSchema }), listVendors);

// Registro: usuario autenticado se convierte en vendor
router.post("/register", protect, validate({ body: registerVendorSchema }), registerVendor);

// Self
router.get("/me", protect, requireVendor, getMyVendor);
router.patch(
  "/me",
  protect,
  requireVendor,
  validate({ body: updateMyVendorSchema }),
  updateMyVendor
);

// Admin
router.patch(
  "/admin/:id",
  protect,
  requireAdmin,
  validate({ params: vendorIdParamSchema, body: adminUpdateVendorSchema }),
  adminUpdateVendor
);
router.post(
  "/admin/:id/deactivate",
  protect,
  requireAdmin,
  validate({ params: vendorIdParamSchema }),
  deactivateVendor
);
router.post(
  "/admin/:id/reactivate",
  protect,
  requireAdmin,
  validate({ params: vendorIdParamSchema }),
  reactivateVendor
);

// Público por id (al final)
router.get("/:id", validate({ params: vendorIdParamSchema }), getPublicVendorById);

export default router;
