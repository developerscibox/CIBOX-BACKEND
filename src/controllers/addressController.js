import { asyncHandler } from "../middlewares/errorHandler.js";
import { Address } from "../models/Address.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";

const ensureOwnership = (doc, userId) => {
  if (!doc) throw new NotFoundError("Dirección no encontrada");
  if (String(doc.user_id) !== String(userId)) {
    throw new ForbiddenError("No tienes permiso sobre esta dirección");
  }
};

export const listMyAddresses = asyncHandler(async (req, res) => {
  const items = await Address.find({ user_id: req.user.id })
    .sort({ is_default: -1, updated_at: -1 })
    .lean();
  res.status(200).json({ success: true, data: items });
});

export const createAddress = asyncHandler(async (req, res) => {
  const count = await Address.countDocuments({ user_id: req.user.id });
  const isDefault = req.body.is_default === true || count === 0;

  const doc = await Address.create({
    ...req.body,
    user_id: req.user.id,
    is_default: isDefault,
  });

  res.status(201).json({
    success: true,
    data: doc.toObject(),
    message: "Dirección creada",
  });
});

export const updateAddress = asyncHandler(async (req, res) => {
  const doc = await Address.findById(req.params.id);
  ensureOwnership(doc, req.user.id);

  const updatable = [
    "label",
    "full_name",
    "phone",
    "rut",
    "street",
    "number",
    "apartment",
    "commune",
    "region",
    "postal_code",
    "is_default",
  ];
  for (const k of updatable) {
    if (k in req.body) doc[k] = req.body[k];
  }
  await doc.save();

  res.status(200).json({
    success: true,
    data: doc.toObject(),
    message: "Dirección actualizada",
  });
});

export const deleteAddress = asyncHandler(async (req, res) => {
  const doc = await Address.findById(req.params.id);
  ensureOwnership(doc, req.user.id);

  const wasDefault = doc.is_default;
  await doc.deleteOne();

  if (wasDefault) {
    const next = await Address.findOne({ user_id: req.user.id }).sort({ updated_at: -1 });
    if (next) {
      next.is_default = true;
      await next.save();
    }
  }

  res.status(200).json({ success: true, message: "Dirección eliminada" });
});

export const setDefault = asyncHandler(async (req, res) => {
  const doc = await Address.findById(req.params.id);
  ensureOwnership(doc, req.user.id);

  doc.is_default = true;
  await doc.save();

  res.status(200).json({
    success: true,
    data: doc.toObject(),
    message: "Dirección por defecto actualizada",
  });
});

export const getDefault = asyncHandler(async (req, res) => {
  const doc = await Address.findOne({ user_id: req.user.id, is_default: true }).lean();
  res.status(200).json({ success: true, data: doc || null });
});
