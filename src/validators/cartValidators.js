import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

export const addItemSchema = {
  body: z.object({
    productId: objectId,
    quantity: z.coerce.number().int().min(1).max(999),
  }),
};

export const updateItemSchema = {
  params: z.object({
    productId: objectId,
  }),
  body: z.object({
    quantity: z.coerce.number().int().min(1).max(999),
  }),
};

export const removeItemSchema = {
  params: z.object({
    productId: objectId,
  }),
};
