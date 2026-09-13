import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

const shippingAddressSchema = z.object({
  region: z.string().min(2).max(80),
  city: z.string().min(2).max(80),
  address: z.string().min(5).max(200),
  addressLine2: z.string().max(120).optional().nullable(),
  reference: z.string().max(200).optional().nullable(),
});

export const previewShippingSchema = {
  body: z.object({
    shipping: shippingAddressSchema,
  }),
};

// /preview-items entraba sin pasar por Zod: el body llegaba tal cual al
// controller. Ahora se exige lo mismo que en /preview (dirección completa) más
// la lista de productos a cotizar.
export const previewShippingFromItemsSchema = {
  body: z.object({
    shipping: shippingAddressSchema,
    items: z
      .array(
        z.object({
          product_id: objectId,
          quantity: z.coerce.number().int().min(1).max(999),
        }),
      )
      .min(1)
      .max(50),
  }),
};

export const quoteShippingByOrderSchema = {
  body: z.object({
    orderId: objectId,
    guestToken: z.string().min(32).max(128).optional().nullable(),
  }),
};

export const applyShippingSchema = {
  body: z.object({
    orderId: objectId,
    city: z.string().min(2).max(80).optional(),
    region: z.string().min(2).max(80).optional(),
    guestToken: z.string().min(32).max(128).optional().nullable(),
  }),
};
