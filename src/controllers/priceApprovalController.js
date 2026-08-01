import { asyncHandler } from "../middlewares/errorHandler.js";
import PriceApproval from "../models/PriceApproval.js";
import { ROLES } from "../utils/constants.js";
import { ForbiddenError } from "../utils/errors.js";
import { createPriceApproval, cancelPriceApproval } from "../services/priceApprovalService.js";

// POST /api/price-approvals (PRODUCTS_MANAGE)
// body { items:[{ product_id, tiers_propuestos:[{min_qty,price,label}] }], motivo? }
export const solicitarCambioPrecio = asyncHandler(async (req, res) => {
  const { items, motivo } = req.body;
  const approval = await createPriceApproval({
    items,
    motivo,
    solicitante: {
      user_id: req.user?.id || null,
      nombre: req.user?.name || req.user?.email || "usuario",
      role: req.user?.role || null,
    },
  });
  res.status(201).json({ success: true, data: { approval } });
});

// GET /api/price-approvals?estado=pendiente|todas (PRODUCTS_MANAGE)
export const listarCambiosPrecio = asyncHandler(async (req, res) => {
  const filter = req.query.estado === "todas" ? {} : { estado: "pendiente" };
  const [items, pendientes] = await Promise.all([
    PriceApproval.find(filter).sort({ created_at: -1 }).limit(50).lean(),
    PriceApproval.countDocuments({ estado: "pendiente" }),
  ]);
  res.json({ success: true, data: { items, pendientes } });
});

// PATCH /api/price-approvals/:id/cancel (PRODUCTS_MANAGE)
// Solo el solicitante o admin/manager pueden cancelar.
export const cancelarCambioPrecio = asyncHandler(async (req, res) => {
  const actual = await PriceApproval.findById(req.params.id).select("solicitante").lean();
  const esDueño = actual && String(actual.solicitante?.user_id || "") === String(req.user?.id || "");
  const esAdmin = req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.MANAGER;
  if (actual && !esDueño && !esAdmin) {
    throw new ForbiddenError("Solo quien la solicitó (o un gerente) puede cancelarla");
  }
  const approval = await cancelPriceApproval({
    id: req.params.id,
    by: { user_id: req.user?.id || null, nombre: req.user?.name || req.user?.email || "usuario" },
  });
  res.json({ success: true, data: { approval } });
});
