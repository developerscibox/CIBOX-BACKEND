import { Router } from "express";

import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { validate } from "../middlewares/validate.js";
import {
  getMovements,
  postAdjustStock,
  postReceiveStock,
  getLowStock,
  getReorderList,
  getExpiringSoon,
  getLotes,
  getLotesExpiring,
  getProductByBarcode,
  getStockSummary,
  postStartCount,
  getCounts,
  getCountById,
  patchCountLines,
  postCloseCount,
  postCancelCount,
} from "../controllers/inventoryController.js";
import {
  listMovementsSchema,
  adjustStockSchema,
  receiveStockSchema,
  lowStockSchema,
  expiringSoonSchema,
  barcodeParamSchema,
} from "../validators/inventoryValidators.js";

const router = Router();

// Autorización por permiso (mínimo privilegio):
//  - leer kardex/low-stock  → inventory.read   (operario, gerente, admin)
//  - ajustar stock          → inventory.adjust (operario, gerente, admin)
//  - lookup por código de barras → cualquier rol WMS autenticado (picking/recepción).
router.get("/movements", protect, requirePermission(PERMISSIONS.INVENTORY_READ), validate(listMovementsSchema), getMovements);
router.post("/adjust", protect, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate(adjustStockSchema), postAdjustStock);
// recepción de mercadería (ingreso masivo) → mismo permiso que ajustar stock
router.post("/receive", protect, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate(receiveStockSchema), postReceiveStock);
router.get("/low-stock", protect, requirePermission(PERMISSIONS.INVENTORY_READ), validate(lowStockSchema), getLowStock);
// lista de reposición (productos bajo su mínimo) → mismo permiso de lectura
router.get("/reorder", protect, requirePermission(PERMISSIONS.INVENTORY_READ), getReorderList);
// productos por vencer (FEFO ligero) → mismo permiso de lectura de inventario
router.get("/expiring-soon", protect, requirePermission(PERMISSIONS.INVENTORY_READ), validate(expiringSoonSchema), getExpiringSoon);
// lotes (Batch): trazabilidad + histórico de costos → lectura de inventario.
// /lotes/expiring antes de /lotes (rutas exactas; orden defensivo).
router.get("/lotes/expiring", protect, requirePermission(PERMISSIONS.INVENTORY_READ), getLotesExpiring);
router.get("/lotes", protect, requirePermission(PERMISSIONS.INVENTORY_READ), getLotes);
router.get("/stock-summary", protect, requirePermission(PERMISSIONS.INVENTORY_READ), getStockSummary);
router.get("/by-barcode/:code", protect, requirePermission(PERMISSIONS.INVENTORY_READ), validate(barcodeParamSchema), getProductByBarcode);

// Conteo físico (cycle count). Las rutas específicas (/counts/:id/close y
// /counts/:id/cancel) van ANTES de /counts/:id para no quedar ocultas por :id.
router.post("/counts", protect, requirePermission(PERMISSIONS.INVENTORY_ADJUST), postStartCount);
router.get("/counts", protect, requirePermission(PERMISSIONS.INVENTORY_READ), getCounts);
router.post("/counts/:id/close", protect, requirePermission(PERMISSIONS.INVENTORY_ADJUST), postCloseCount);
router.post("/counts/:id/cancel", protect, requirePermission(PERMISSIONS.INVENTORY_ADJUST), postCancelCount);
router.patch("/counts/:id", protect, requirePermission(PERMISSIONS.INVENTORY_ADJUST), patchCountLines);
router.get("/counts/:id", protect, requirePermission(PERMISSIONS.INVENTORY_READ), getCountById);

export default router;
