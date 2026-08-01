import { asyncHandler } from "../middlewares/errorHandler.js";
import * as refundService from "../services/refundService.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
import { getRequestIdentity } from "../utils/ownership.js";

export const requestRefund = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  if (!identity.userId && !identity.guestId) {
    throw new UnauthorizedError("Identidad requerida (login o guest_id)");
  }

  const { order_id, reason, description, type, items } = req.body;
  const refund = await refundService.requestRefund({
    orderId: order_id,
    identity,
    reason,
    description,
    items,
    type,
  });

  res.status(201).json({
    success: true,
    data: { refund },
    message: "Solicitud de reembolso creada",
  });
});

export const listMyRefunds = asyncHandler(async (req, res) => {
  const result = await refundService.listRefunds({
    status: req.query.status,
    userId: req.user.id,
    adminView: false,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

export const getRefund = asyncHandler(async (req, res) => {
  const refund = await refundService.getRefundById(req.params.id);
  const isAdmin = req.user?.role === "admin";
  if (!isAdmin && String(refund.user_id || "") !== String(req.user.id)) {
    throw new ForbiddenError("No tienes permiso sobre este refund");
  }

  res.status(200).json({
    success: true,
    data: { refund },
  });
});

export const listAll = asyncHandler(async (req, res) => {
  const result = await refundService.listRefunds({
    status: req.query.status,
    userId: req.query.user_id,
    adminView: true,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

export const approve = asyncHandler(async (req, res) => {
  const refund = await refundService.approveRefund({
    refundId: req.body.refund_id,
    adminId: req.user.id,
  });

  res.status(200).json({
    success: true,
    data: { refund },
    message: "Refund aprobado",
  });
});

export const reject = asyncHandler(async (req, res) => {
  const refund = await refundService.rejectRefund({
    refundId: req.body.refund_id,
    adminId: req.user.id,
    reason: req.body.reason,
  });

  res.status(200).json({
    success: true,
    data: { refund },
    message: "Refund rechazado",
  });
});
