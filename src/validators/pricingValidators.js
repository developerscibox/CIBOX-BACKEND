import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "ID inválido");

export const calculateItemPricingSchema = z.object({
  productId: objectIdSchema,
  quantity: z.coerce.number().int().min(1).max(9999),
  fromPantry: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional(),
});
