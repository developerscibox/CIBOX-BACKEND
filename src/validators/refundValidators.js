import { z } from "zod";
import { REFUND_REASONS_LIST, REFUND_STATUSES_LIST } from "../models/Refund.js";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

const refundItemSchema = z.object({
  product_id: objectIdSchema,
  quantity: z.coerce.number().int().positive(),
  amount: z.coerce.number().nonnegative(),
});

export const requestRefundSchema = z
  .object({
    order_id: objectIdSchema,
    reason: z.enum(REFUND_REASONS_LIST),
    description: z.string().trim().max(2000).optional().default(""),
    type: z.enum(["full", "partial"]),
    items: z.array(refundItemSchema).optional().default([]),
  })
  .refine(
    (data) => data.type === "full" || (data.items && data.items.length > 0),
    { message: "Refunds parciales requieren items", path: ["items"] }
  );

export const approveRefundSchema = z.object({
  refund_id: objectIdSchema,
});

export const rejectRefundSchema = z.object({
  refund_id: objectIdSchema,
  reason: z.string().trim().min(1, "Motivo requerido").max(500),
});

export const listRefundsSchema = z.object({
  status: z.enum(REFUND_STATUSES_LIST).optional(),
  user_id: objectIdSchema.optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const refundIdParamsSchema = z.object({
  id: objectIdSchema,
});
