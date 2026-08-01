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
