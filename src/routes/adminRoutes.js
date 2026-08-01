import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { requireAdmin, requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { validate } from "../middlewares/validate.js";
import {
  updateOrderStatusSchema,
  updateUserRoleSchema,
  toggleUserActiveSchema,
  salesSummaryQuerySchema,
  listOrdersSchema,
  listUsersSchema,
  exportOrdersQuerySchema,
  idParamSchema,
} from "../validators/adminValidators.js";
import {
  getSalesSummary,
  getTopSellingProducts,
  getBottomSellingProducts,
  getAudit,
  getDashboardMetrics,
  updateOrderStatus,
  listOrders,
  updateUserRole,
  listUsers,
  toggleUserActive,
  exportOrdersCSV,
} from "../controllers/adminController.js";
import { getGerencia } from "../controllers/gerenciaController.js";
import { getDashboard360 } from "../controllers/dashboard360Controller.js";

const router = Router();

// Todas requieren sesión; el permiso fino va por ruta (mínimo privilegio).
router.use(protect);

// Reportes — admin + manager (reports.read). Consumido por la consola "Ventas" del WMS.
router.get("/dashboard", requirePermission(PERMISSIONS.REPORTS_READ), getDashboardMetrics);
router.get("/sales-summary", requirePermission(PERMISSIONS.REPORTS_READ), validate({ query: salesSummaryQuerySchema }), getSalesSummary);
router.get("/top-products", requirePermission(PERMISSIONS.REPORTS_READ), validate({ query: salesSummaryQuerySchema }), getTopSellingProducts);
router.get("/bottom-products", requirePermission(PERMISSIONS.REPORTS_READ), validate({ query: salesSummaryQuerySchema }), getBottomSellingProducts);
router.get("/gerencia", requirePermission(PERMISSIONS.REPORTS_READ), getGerencia);
// Dashboard Gerencial 360°: foto ejecutiva del día + mes (mismo permiso que /gerencia).
router.get("/gerencia/dashboard360", requirePermission(PERMISSIONS.REPORTS_READ), getDashboard360);
router.get("/audit", requirePermission(PERMISSIONS.REPORTS_READ), getAudit);

// Órdenes (reportes/export)
router.get("/orders", requirePermission(PERMISSIONS.REPORTS_READ), validate({ query: listOrdersSchema }), listOrders);
router.get("/orders/export", requirePermission(PERMISSIONS.REPORTS_READ), validate({ query: exportOrdersQuerySchema }), exportOrdersCSV);
router.patch(
  "/orders/:id/status",
  requireAdmin,
  validate({ params: idParamSchema, body: updateOrderStatusSchema }),
  updateOrderStatus
);

// Usuarios — admin + manager (users.manage)
router.get("/users", requirePermission(PERMISSIONS.USERS_MANAGE), validate({ query: listUsersSchema }), listUsers);
router.patch(
  "/users/:id/role",
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate({ params: idParamSchema, body: updateUserRoleSchema }),
  updateUserRole
);
router.patch(
  "/users/:id/active",
  requirePermission(PERMISSIONS.USERS_MANAGE),
  validate({ params: idParamSchema, body: toggleUserActiveSchema }),
  toggleUserActive
);

export default router;
