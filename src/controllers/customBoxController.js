import { asyncHandler } from "../middlewares/errorHandler.js";
import { CustomBox } from "../models/CustomBox.js";
import { Product } from "../models/Product.js";
import { User } from "../models/User.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors.js";
import {
  getOwnerAssign,
  getOwnerFilter,
  assertOwner,
} from "../utils/ownership.js";
import { calculateItemPricing } from "../services/pricingService.js";
import { logger } from "../utils/logger.js";

const recalcTotals = (box) => {
  const subtotal = box.items.reduce(
    (acc, it) => acc + Number(it.subtotal || 0),
    0
  );
  box.subtotal = subtotal;
  box.total = subtotal + Number(box.shipping_estimate || 0);
};

const buildItemFromPricing = (product, quantity, pricing) => ({
  product_id: product._id,
  name: product.name,
  thumbnail: product.thumbnail || product.images?.[0] || "",
  quantity,
  unit_price: pricing.unit_price,
  original_unit_price: pricing.original_unit_price,
  tier_label: pricing.tier_label,
  discount_applied: pricing.discount_applied,
  discount_percent: pricing.discount_percent,
  discount_amount_per_unit: pricing.discount_amount_per_unit,
  discount_source: pricing.discount_source,
  subtotal: pricing.subtotal,
  original_subtotal: pricing.original_subtotal,
});

const fetchUser = async (req) => {
  if (!req.user?.id) return null;
  return User.findById(req.user.id).lean();
};

const ensureOwnerOrFail = (req) => {
  const owner = getOwnerAssign(req);
  if (!owner.user_id && !owner.guest_id) {
    throw new UnauthorizedError("Se requiere autenticación o x-guest-id");
  }
  return owner;
};

export const createCustomBox = asyncHandler(async (req, res) => {
  const owner = ensureOwnerOrFail(req);
  const user = await fetchUser(req);
  const { name, items: incomingItems = [] } = req.body;

  const items = [];
  for (const it of incomingItems) {
    const product = await Product.findById(it.productId);
    if (!product || product.is_active === false) {
      throw new NotFoundError(`Producto no encontrado o inactivo: ${it.productId}`);
    }
    const pricing = calculateItemPricing({
      tiers: product.pricing.tiers,
      quantity: it.quantity,
      product,
      user,
    });
    items.push(buildItemFromPricing(product, it.quantity, pricing));
  }

  const box = new CustomBox({
    ...owner,
    name: name || null,
    items,
    status: "draft",
  });
  recalcTotals(box);
  await box.save();

  logger.info(
    { box_id: String(box._id), owner_user: owner.user_id, owner_guest: owner.guest_id },
    "custom_box.created"
  );

  return res.status(201).json({
    success: true,
    data: { customBox: box.toObject() },
    message: "Caja creada correctamente",
  });
});

export const getMyCustomBoxes = asyncHandler(async (req, res) => {
  const filter = getOwnerFilter(req);
  if (!filter) {
    return res.status(200).json({
      success: true,
      data: { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
    });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const queryFilter = { ...filter };
  if (req.query.status) queryFilter.status = req.query.status;

  const [items, total] = await Promise.all([
    CustomBox.find(queryFilter)
      .sort({ updated_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomBox.countDocuments(queryFilter),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
  });
});

export const getCustomBoxById = asyncHandler(async (req, res) => {
  const box = await CustomBox.findById(req.params.id).lean();
  if (!box) throw new NotFoundError("Caja no encontrada");
  if (!assertOwner(req, box)) throw new ForbiddenError("No autorizado para esta caja");

  return res.status(200).json({
    success: true,
    data: { customBox: box },
  });
});

export const updateCustomBox = asyncHandler(async (req, res) => {
  const box = await CustomBox.findById(req.params.id);
  if (!box) throw new NotFoundError("Caja no encontrada");
  if (!assertOwner(req, box)) throw new ForbiddenError("No autorizado para esta caja");
  if (box.status !== "draft") {
    throw new BadRequestError("Solo se pueden modificar cajas en estado draft");
  }

  if (req.body.name !== undefined) box.name = req.body.name;
  await box.save();

  return res.status(200).json({
    success: true,
    data: { customBox: box.toObject() },
    message: "Caja actualizada",
  });
});

export const deleteCustomBox = asyncHandler(async (req, res) => {
  const box = await CustomBox.findById(req.params.id);
  if (!box) throw new NotFoundError("Caja no encontrada");
  if (!assertOwner(req, box)) throw new ForbiddenError("No autorizado para esta caja");
  if (box.status !== "draft") {
    throw new BadRequestError("Solo se pueden eliminar cajas en estado draft");
  }

  await box.deleteOne();
  logger.info({ box_id: String(box._id) }, "custom_box.deleted");

  return res.status(200).json({
    success: true,
    message: "Caja eliminada",
  });
});

export const addItem = asyncHandler(async (req, res) => {
  const { productId, quantity } = req.body;
  const box = await CustomBox.findById(req.params.id);
  if (!box) throw new NotFoundError("Caja no encontrada");
  if (!assertOwner(req, box)) throw new ForbiddenError("No autorizado para esta caja");
  if (box.status !== "draft") {
    throw new BadRequestError("Solo se pueden modificar cajas en estado draft");
  }

  const product = await Product.findById(productId);
  if (!product || product.is_active === false) {
    throw new NotFoundError("Producto no encontrado o inactivo");
  }

  const user = await fetchUser(req);

  const idx = box.items.findIndex(
    (it) => String(it.product_id) === String(productId)
  );
  const newQty = idx >= 0 ? box.items[idx].quantity + quantity : quantity;

  const pricing = calculateItemPricing({
    tiers: product.pricing.tiers,
    quantity: newQty,
    product,
    user,
  });

  if (idx >= 0) {
    box.items[idx] = buildItemFromPricing(product, newQty, pricing);
  } else {
    box.items.push(buildItemFromPricing(product, newQty, pricing));
  }

  recalcTotals(box);
  await box.save();

  return res.status(200).json({
    success: true,
    data: { customBox: box.toObject() },
    message: "Producto agregado a la caja",
  });
});

export const updateItem = asyncHandler(async (req, res) => {
  const { quantity } = req.body;
  const box = await CustomBox.findById(req.params.id);
  if (!box) throw new NotFoundError("Caja no encontrada");
  if (!assertOwner(req, box)) throw new ForbiddenError("No autorizado para esta caja");
  if (box.status !== "draft") {
    throw new BadRequestError("Solo se pueden modificar cajas en estado draft");
  }

  const idx = box.items.findIndex(
    (it) => String(it.product_id) === String(req.params.productId)
  );
  if (idx < 0) throw new NotFoundError("Producto no existe en la caja");

  const product = await Product.findById(req.params.productId);
  if (!product) throw new NotFoundError("Producto no encontrado");

  const user = await fetchUser(req);
  const pricing = calculateItemPricing({
    tiers: product.pricing.tiers,
    quantity,
    product,
    user,
  });
  box.items[idx] = buildItemFromPricing(product, quantity, pricing);

  recalcTotals(box);
  await box.save();

  return res.status(200).json({
    success: true,
    data: { customBox: box.toObject() },
    message: "Cantidad actualizada",
  });
});

export const removeItem = asyncHandler(async (req, res) => {
  const box = await CustomBox.findById(req.params.id);
  if (!box) throw new NotFoundError("Caja no encontrada");
  if (!assertOwner(req, box)) throw new ForbiddenError("No autorizado para esta caja");
  if (box.status !== "draft") {
    throw new BadRequestError("Solo se pueden modificar cajas en estado draft");
  }

  const before = box.items.length;
  box.items = box.items.filter(
    (it) => String(it.product_id) !== String(req.params.productId)
  );
  if (box.items.length === before) {
    throw new NotFoundError("Producto no existe en la caja");
  }

  recalcTotals(box);
  await box.save();

  return res.status(200).json({
    success: true,
    data: { customBox: box.toObject() },
    message: "Producto eliminado de la caja",
  });
});
