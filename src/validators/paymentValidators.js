import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

export const createWebpaySchema = {
  body: z.object({
    orderId: objectId,
    platform: z.enum(["ios", "android", "web", "native"]).optional(),
    guestToken: z.string().min(32).max(128).optional().nullable(),
  }),
};

export const commitWebpaySchema = {
  body: z.object({
    token: z.string().min(8).max(256),
  }),
};

export const webpayReturnSchema = {
  query: z.object({
    token_ws: z.string().optional(),
    TBK_TOKEN: z.string().optional(),
    TBK_ORDEN_COMPRA: z.string().optional(),
  }).passthrough(),
};
