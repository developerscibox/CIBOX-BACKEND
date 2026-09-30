import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { TaxDocument } from "../models/TaxDocument.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
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

/**
 * Marcar a mano un documento pendiente como EMITIDO.
 *
 * Con la emisión automática apagada (SII_ENABLED=false) cada venta pagada deja
 * un documento con folio nulo y estado "pending". La boleta real la emite una
 * persona en el portal del SII, y acá anota el folio que le tocó para que el
 * listado deje de mostrarla como pendiente.
 *
 * Es una anotación contable, no una emisión: nada se manda al SII desde aquí.
 */
export const markDocumentEmitted = asyncHandler(async (req, res) => {
  const { folio, emitted_at } = req.body;

  const doc = await TaxDocument.findById(req.params.id);
  if (!doc) throw new NotFoundError("Documento no encontrado");

  // Nunca se pisa un folio ya anotado en silencio: si la boleta ya figura
  // emitida, quien la marcó antes puso un número y hay que revisarlo a mano.
  if (doc.status === "accepted") {
    throw new ConflictError(
      `Esta boleta ya está marcada como emitida (folio ${doc.folio || "sin folio"})`,
    );
  }
  if (doc.status === "voided") {
    throw new ConflictError("Esta boleta está anulada: no se puede marcar como emitida");
  }

  // El folio tiene índice, pero NO único: la unicidad se comprueba acá. Dos
  // boletas con el mismo folio dejarían la contabilidad sin forma de saber a
  // qué venta corresponde cada una.
  const conMismoFolio = await TaxDocument.findOne({ folio }).select("_id").lean();
  if (conMismoFolio && String(conMismoFolio._id) !== String(doc._id)) {
    throw new ConflictError(
      `El folio ${folio} ya está usado por otro documento: dos boletas no pueden compartir folio`,
    );
  }

  doc.folio = folio;
  doc.status = "accepted";
  doc.emitted_at = emitted_at ? new Date(emitted_at) : new Date();
  // Deja de ser un documento de prueba: corresponde a uno real del SII.
  doc.stub = false;

  try {
    await doc.save();
  } catch (err) {
    // El índice único parcial { order_id, type } cubre pending/accepted. Un
    // documento rechazado que vuelve a "accepted" puede chocar con otro que ya
    // esté activo para el mismo pedido y tipo: eso es un 409, no un 500.
    if (err?.code === 11000) {
      throw new ConflictError(
        "Ya existe otro documento activo para este pedido y tipo: revísalo antes de marcar este",
      );
    }
    throw err;
  }

  logger.info(
    {
      tax_document_id: String(doc._id),
      order_id: String(doc.order_id),
      type: doc.type,
      folio: doc.folio,
      emitted_at: doc.emitted_at,
      by: req.user?.id,
    },
    "tax_document.marcado_emitido_a_mano",
  );

  res.status(200).json({ success: true, data: doc.toObject() });
});

export const voidDocument = asyncHandler(async (req, res) => {
  const result = await siiService.voidDocument(req.body.folio);
  res.status(200).json({
    success: true,
    data: { document: result },
    message: "Documento anulado",
  });
});
