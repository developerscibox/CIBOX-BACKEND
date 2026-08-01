import AuditLog from "../models/AuditLog.js";
import { logger } from "./logger.js";

// Registra una acción sensible en la bitácora. Fire-and-forget: NUNCA lanza ni
// bloquea la operación principal (si la bitácora falla, solo se loguea).
export const logAudit = ({ req, action, target = null, detail = null }) => {
  try {
    const u = req?.user || {};
    AuditLog.create({
      action,
      actor: { user_id: u.id || null, role: u.role || null, label: u.name || u.email || null },
      target,
      detail,
    }).catch((e) => logger.warn({ err: e.message, action }, "logAudit falló"));
  } catch (e) {
    logger.warn({ err: e.message }, "logAudit error");
  }
};

export default logAudit;
