import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "ID inválido");

export const createCustomBoxSchema = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  items: z
    .array(
      z.object({
        productId: objectIdSchema,
        quantity: z.number().int().min(1).max(999),
      })
    )
    .max(200)
    .optional(),
});

export const updateCustomBoxSchema = z
  .object({
    name: z.string().trim().max(120).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debes enviar al menos un campo a actualizar",
  });

export const customBoxParamsSchema = z.object({
  id: objectIdSchema,
});

export const customBoxItemParamsSchema = z.object({
  id: objectIdSchema,
  productId: objectIdSchema,
});

export const addItemSchema = z.object({
  productId: objectIdSchema,
  quantity: z.number().int().min(1).max(999),
});

export const updateItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
});

export const listCustomBoxesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  status: z.enum(["draft", "ordered"]).optional(),
});
