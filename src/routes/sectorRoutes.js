import { Router } from "express";

import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { listSectores, upsertSectores } from "../controllers/sectorController.js";

const router = Router();

router.get("/", protect, requirePermission(PERMISSIONS.ORDERS_READ), listSectores);
router.put("/", protect, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), upsertSectores);

export default router;
