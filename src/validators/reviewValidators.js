import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "ID inválido");

export const createReviewSchema = z.object({
  productId: objectIdSchema,
  orderId: objectIdSchema.optional().nullable(),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).optional(),
  comment: z.string().trim().max(4000).optional(),
  images: z.array(z.string().trim().url()).max(5).optional(),
});

export const updateReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    title: z.string().trim().max(120).optional(),
    comment: z.string().trim().max(4000).optional(),
    images: z.array(z.string().trim().url()).max(5).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debes enviar al menos un campo a actualizar",
  });

export const moderateReviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  rejection_reason: z.string().trim().max(500).optional(),
});

export const reviewParamsSchema = z.object({
  id: objectIdSchema,
});

export const productReviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(["recent", "helpful", "rating_desc", "rating_asc"]).optional(),
});

export const productReviewsParamsSchema = z.object({
  productId: objectIdSchema,
});

export const adminReviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
  productId: objectIdSchema.optional(),
});
