import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { requireVendor } from "../middlewares/roleMiddleware.js";
import { validate } from "../middlewares/validate.js";
import { salesSummaryQuerySchema } from "../validators/adminValidators.js";
import {
  getMyStats,
  getMyRevenue,
  getMyProducts,
  getMyOrders,
  getTopProductsForVendor,
} from "../controllers/vendorDashboardController.js";

const router = Router();

router.use(protect, requireVendor);

router.get("/stats", getMyStats);
router.get("/revenue", validate({ query: salesSummaryQuerySchema }), getMyRevenue);
router.get("/products", getMyProducts);
router.get("/orders", getMyOrders);
router.get("/top-products", validate({ query: salesSummaryQuerySchema }), getTopProductsForVendor);

export default router;
