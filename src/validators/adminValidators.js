import { z } from "zod";
import mongoose from "mongoose";
import { ORDER_STATUS, ROLES } from "../utils/constants.js";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .refine((v) => mongoose.Types.ObjectId.isValid(v), { message: "ID inválido" });

const dateSchema = z.coerce.date();

export const updateOrderStatusSchema = z.object({
  newStatus: z.enum(Object.values(ORDER_STATUS)),
  reason: z.string().trim().max(500).optional(),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(Object.values(ROLES)),
});

export const toggleUserActiveSchema = z.object({
  is_active: z.boolean(),
});

export const salesSummaryQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    vendor_id: objectIdSchema.optional(),
    group_by: z.enum(["day", "week", "month", "quarter"]).default("day"),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine(
    (data) => !(data.from && data.to) || data.from <= data.to,
    { message: "from debe ser menor o igual a to", path: ["to"] }
  );

export const listOrdersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(Object.values(ORDER_STATUS)).optional(),
  vendor_id: objectIdSchema.optional(),
  user_id: objectIdSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  role: z.enum(Object.values(ROLES)).optional(),
  is_active: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
});

export const exportOrdersQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  status: z.enum(Object.values(ORDER_STATUS)).optional(),
});

export const idParamSchema = z.object({ id: objectIdSchema });
