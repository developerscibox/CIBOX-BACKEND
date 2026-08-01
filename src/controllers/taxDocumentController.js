import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { TaxDocument } from "../models/TaxDocument.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";
import * as siiService from "../services/siiService.js";

const getOrderModel = () => mongoose.models.Order || null;

export const emitForOrder = asyncHandler(async (req, res) => {
  const { order_id, type } = req.body;
  const Order = getOrderModel();
  if (!Order) throw new NotFoundError("Order model no disponible");

  const order = await Order.findById(order_id).lean();
  if (!order) throw new NotFoundError("Orden no encontrada");

  const doc = await siiService.emitDocumentForOrder(order, type);
  res.status(201).json({
    success: true,
    data: { document: doc },
    message: "Documento tributario emitido",
  });
});

export const getMyDocuments = asyncHandler(async (req, res) => {
  const Order = getOrderModel();
  if (!Order) {
    return res.status(200).json({ success: true, data: { items: [], total: 0 } });
  }

  const orderIds = await Order.find({ user_id: req.user.id }).distinct("_id");
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const filter = { order_id: mongoose.trusted({ $in: orderIds }) };
  const [items, total] = await Promise.all([
    TaxDocument.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    TaxDocument.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: { items, total, page, limit },
  });
});

export const listAllDocuments = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.order_id && /^[a-fA-F0-9]{24}$/.test(String(req.query.order_id))) {
    filter.order_id = req.query.order_id;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;

  const [items, total] = await Promise.all([
    TaxDocument.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    TaxDocument.countDocuments(filter),
  ]);

  res.status(200).json({ success: true, data: { items, total, page, limit } });
});

export const getDocumentById = asyncHandler(async (req, res) => {
  const doc = await TaxDocument.findById(req.params.id).lean();
  if (!doc) throw new NotFoundError("Documento no encontrado");

  const isAdmin = req.user?.role === "admin";
  if (!isAdmin) {
    const Order = getOrderModel();
    if (!Order) throw new ForbiddenError("No autorizado");
    const order = await Order.findById(doc.order_id).select("user_id").lean();
    if (!order || String(order.user_id || "") !== String(req.user.id)) {
      throw new ForbiddenError("No tienes permiso sobre este documento");
    }
  }

  res.status(200).json({ success: true, data: { document: doc } });
});

export const voidDocument = asyncHandler(async (req, res) => {
  const result = await siiService.voidDocument(req.body.folio);
  res.status(200).json({
    success: true,
    data: { document: result },
    message: "Documento anulado",
  });
});
