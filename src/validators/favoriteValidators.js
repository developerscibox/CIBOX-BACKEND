import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "ID inválido");

export const addFavoriteSchema = z.object({
  productId: objectIdSchema,
});

export const favoriteParamsSchema = z.object({
  productId: objectIdSchema,
});

export const isFavoriteQuerySchema = z.object({
  productId: objectIdSchema,
});

export const listFavoritesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
});
