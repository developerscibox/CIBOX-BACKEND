import { asyncHandler } from "../middlewares/errorHandler.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { ROLES } from "../utils/constants.js";

import Vendor from "../models/Vendor.js";
import { User } from "../models/User.js";

const VENDOR_SELF_FIELDS = new Set([
  "name",
  "description",
  "logo_url",
  "banner_url",
  "commune",
  "region",
  "address",
  "bank_info",
]);

const ADMIN_VENDOR_FIELDS = new Set([
  ...VENDOR_SELF_FIELDS,
  "rut",
  "is_active",
  "is_verified",
  "commission_rate",
]);

const FORBIDDEN = new Set(["user_id", "stats", "_id", "created_at", "updated_at"]);

const pick = (data, allowed) => {
  const out = {};
  for (const key of Object.keys(data)) {
    if (FORBIDDEN.has(key)) continue;
    if (allowed.has(key)) out[key] = data[key];
  }
  return out;
};

export const registerVendor = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const existing = await Vendor.findOne({ user_id: userId }).lean();
  if (existing) throw new ConflictError("Ya tienes un vendor registrado");

  const user = await User.findById(userId);
  if (!user) throw new NotFoundError("Usuario no encontrado");

  const vendor = await Vendor.create({
    user_id: userId,
    ...req.body,
  });

  // Solo subir el rol si no es admin
  if (user.role !== ROLES.ADMIN) {
    user.role = ROLES.VENDOR;
    await user.save();
  }

  logger.info({ vendor_id: String(vendor._id), user_id: userId }, "vendor registered");
  res.status(201).json({ success: true, data: vendor, message: "Vendor creado" });
});

export const getMyVendor = asyncHandler(async (req, res) => {
  const vendor = await Vendor.findOne({ user_id: req.user.id }).lean();
  if (!vendor) throw new NotFoundError("Vendor no encontrado");
  res.json({ success: true, data: vendor });
});

export const updateMyVendor = asyncHandler(async (req, res) => {
  const update = pick(req.body, VENDOR_SELF_FIELDS);
  if (!Object.keys(update).length) {
    throw new BadRequestError("No hay campos válidos para actualizar");
  }

  const vendor = await Vendor.findOneAndUpdate(
    { user_id: req.user.id },
    update,
    { new: true, runValidators: true }
  ).lean();

  if (!vendor) throw new NotFoundError("Vendor no encontrado");
  logger.info({ vendor_id: String(vendor._id) }, "vendor updated by self");
  res.json({ success: true, data: vendor, message: "Vendor actualizado" });
});

export const adminUpdateVendor = asyncHandler(async (req, res) => {
  const update = pick(req.body, ADMIN_VENDOR_FIELDS);
  const vendor = await Vendor.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true,
  }).lean();
  if (!vendor) throw new NotFoundError("Vendor no encontrado");
  logger.info({ vendor_id: String(vendor._id), by_admin: req.user.id }, "vendor updated");
  res.json({ success: true, data: vendor, message: "Vendor actualizado" });
});

export const deactivateVendor = asyncHandler(async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new NotFoundError("Vendor no encontrado");

  vendor.is_active = false;
  await vendor.save();

  // Solo bajar rol si era vendor (preservar admin)
  const user = await User.findById(vendor.user_id);
  if (user && user.role === ROLES.VENDOR) {
    user.role = ROLES.CUSTOMER;
    await user.save();
  }

  logger.info({ vendor_id: String(vendor._id) }, "vendor deactivated");
  res.json({ success: true, data: vendor, message: "Vendor desactivado" });
});

export const reactivateVendor = asyncHandler(async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new NotFoundError("Vendor no encontrado");
  vendor.is_active = true;
  await vendor.save();

  // Restaurar rol vendor solo si el usuario era customer
  const user = await User.findById(vendor.user_id);
  if (user && user.role === ROLES.CUSTOMER) {
    user.role = ROLES.VENDOR;
    await user.save();
  }

  logger.info({ vendor_id: String(vendor._id) }, "vendor reactivated");
  res.json({ success: true, data: vendor, message: "Vendor reactivado" });
});

export const getPublicVendorById = asyncHandler(async (req, res) => {
  const vendor = await Vendor.findOne({ _id: req.params.id, is_active: true })
    .select("name description logo_url banner_url commune region stats is_verified created_at")
    .lean();
  if (!vendor) throw new NotFoundError("Vendor no encontrado");
  res.json({ success: true, data: vendor });
});

export const listVendors = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search,
    commune,
    region,
    is_active,
    is_verified,
  } = req.query;

  const filters = {};
  if (is_active === undefined) filters.is_active = true;
  else filters.is_active = is_active;
  if (is_verified !== undefined) filters.is_verified = is_verified;
  if (commune) filters.commune = commune;
  if (region) filters.region = region;
  if (search) {
    const safe = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filters.name = { $regex: safe, $options: "i" };
  }

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Vendor.find(filters)
      .select("name description logo_url banner_url commune region stats is_verified created_at")
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Vendor.countDocuments(filters),
  ]);

  res.json({
    success: true,
    data: {
      items,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    },
  });
});
