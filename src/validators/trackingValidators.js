import { z } from "zod";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

export const trackingParamsSchema = z.object({
  id: objectIdSchema,
});

export const trackingQuerySchema = z.object({
  token: z.string().trim().min(8).max(256).optional(),
});

export const blueexpressWebhookSchema = z.object({
  tracking_number: z.string().trim().min(1).optional(),
  trackingNumber: z.string().trim().min(1).optional(),
  guide: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  shipment_status: z.string().trim().min(1).optional(),
}).passthrough();
