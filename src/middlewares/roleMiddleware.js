import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
import { roleHasPermission, WMS_ROLES } from "../utils/constants.js";

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  if (!roles.includes(req.user.role)) return next(new ForbiddenError("Rol insuficiente"));
  next();
};

export const requireAdmin = requireRole("admin");
export const requireVendor = requireRole("vendor", "admin");

// Acceso al panel de bodega (cualquier rol operativo del WMS).
export const requireWmsAccess = requireRole(...WMS_ROLES);

/**
 * requirePermission(...perms): exige TODOS los permisos indicados (AND).
 * admin siempre pasa (roleHasPermission lo resuelve).
 */
export const requirePermission = (...perms) => (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  const ok = perms.every((p) => roleHasPermission(req.user.role, p));
  if (!ok) return next(new ForbiddenError("Permiso insuficiente"));
  next();
};

/**
 * requireAnyPermission(...perms): basta con UNO de los permisos (OR).
 * Útil en rutas compartidas por varios roles (p.ej. transición de pedido,
 * donde el control fino del estado destino lo hace el controller).
 */
export const requireAnyPermission = (...perms) => (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  const ok = perms.some((p) => roleHasPermission(req.user.role, p));
  if (!ok) return next(new ForbiddenError("Permiso insuficiente"));
  next();
};
