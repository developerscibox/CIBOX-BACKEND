import mongoose from "mongoose";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { NotFoundError } from "../utils/errors.js";
import { PAID_STATUSES } from "../utils/constants.js";

import Vendor from "../models/Vendor.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";

const getMyVendorOrThrow = async (userId) => {
  const vendor = await Vendor.findOne({ user_id: userId }).select("_id name").lean();
  if (!vendor) throw new NotFoundError("Vendor no encontrado");
  return vendor;
};

const buildDateMatch = (from, to) => {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  return range;
};

export const getMyStats = asyncHandler(async (req, res) => {
  const vendor = await getMyVendorOrThrow(req.user.id);
  const vendorIdStr = String(vendor._id);

  const [totals, productCounts] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: PAID_STATUSES } } },
      { $unwind: "$items" },
      { $match: { "items.vendor.id": vendorIdStr } },
      {
        $group: {
          _id: null,
          total_units_sold: { $sum: "$items.quantity" },
          total_revenue: { $sum: "$items.subtotal" },
          orders: { $addToSet: "$_id" },
        },
      },
      {
        $project: {
          _id: 0,
          total_units_sold: 1,
          total_revenue: 1,
          total_orders: { $size: "$orders" },
        },
      },
    ]),
    Product.aggregate([
      { $match: { "vendor.id": vendorIdStr } },
      {
        $group: {
          _id: null,
          total_products: { $sum: 1 },
          active_products: { $sum: { $cond: ["$is_active", 1, 0] } },
          inactive_products: { $sum: { $cond: ["$is_active", 0, 1] } },
        },
      },
    ]),
  ]);

  const sales = totals[0] || { total_units_sold: 0, total_revenue: 0, total_orders: 0 };
  const products = productCounts[0] || {
    total_products: 0,
    active_products: 0,
    inactive_products: 0,
  };

  res.json({
    success: true,
    data: {
      vendor: { id: vendor._id, name: vendor.name },
      sales,
      products,
    },
  });
});

export const getMyRevenue = asyncHandler(async (req, res) => {
  const vendor = await getMyVendorOrThrow(req.user.id);
  const vendorIdStr = String(vendor._id);

  const match = { status: { $in: PAID_STATUSES } };
  const dateMatch = buildDateMatch(req.query.from, req.query.to);
  if (dateMatch) match.created_at = dateMatch;

  const groupBy = req.query.group_by === "month" ? "%Y-%m" : "%Y-%m-%d";

  const series = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.vendor.id": vendorIdStr } },
    {
      $group: {
        _id: { $dateToString: { format: groupBy, date: "$created_at" } },
        revenue: { $sum: "$items.subtotal" },
        units: { $sum: "$items.quantity" },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, period: "$_id", revenue: 1, units: 1 } },
  ]);

  const totals = series.reduce(
    (acc, p) => {
      acc.revenue += p.revenue;
      acc.units += p.units;
      return acc;
    },
    { revenue: 0, units: 0 }
  );

  res.json({ success: true, data: { totals, series } });
});

export const getMyProducts = asyncHandler(async (req, res) => {
  const vendor = await getMyVendorOrThrow(req.user.id);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const filters = { "vendor.id": String(vendor._id) };
  if (req.query.is_active !== undefined) {
    filters.is_active = req.query.is_active === "true" || req.query.is_active === true;
  }

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Product.find(filters).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filters),
  ]);

  res.json({
    success: true,
    data: { items, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } },
  });
});

export const getMyOrders = asyncHandler(async (req, res) => {
  const vendor = await getMyVendorOrThrow(req.user.id);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const vendorIdStr = String(vendor._id);

  const filters = { items: { $elemMatch: { "vendor.id": vendorIdStr } } };
  if (req.query.status) filters.status = req.query.status;
  const dateMatch = buildDateMatch(req.query.from, req.query.to);
  if (dateMatch) filters.created_at = dateMatch;

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filters).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filters),
  ]);

  // Recortar items: solo del vendor
  const items = orders.map((o) => ({
    ...o,
    items: (o.items || []).filter((it) => String(it.vendor?.id) === vendorIdStr),
  }));

  res.json({
    success: true,
    data: { items, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } },
  });
});

export const getTopProductsForVendor = asyncHandler(async (req, res) => {
  const vendor = await getMyVendorOrThrow(req.user.id);
  const vendorIdStr = String(vendor._id);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

  const match = { status: { $in: PAID_STATUSES } };
  const dateMatch = buildDateMatch(req.query.from, req.query.to);
  if (dateMatch) match.created_at = dateMatch;

  const top = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.vendor.id": vendorIdStr } },
    {
      $group: {
        _id: "$items.product_id",
        name: { $first: "$items.name" },
        total_quantity: { $sum: "$items.quantity" },
        total_revenue: { $sum: "$items.subtotal" },
      },
    },
    { $sort: { total_quantity: -1 } },
    { $limit: limit },
  ]);

  res.json({ success: true, data: top });
});
