import { z } from "zod";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

export const emitForOrderSchema = z.object({
  order_id: objectIdSchema,
  type: z.enum(["boleta", "factura"]).optional().default("boleta"),
});

export const voidDocumentSchema = z.object({
  folio: z.string().trim().min(1, "Folio requerido").max(60),
});

export const taxDocumentIdParamsSchema = z.object({
  id: objectIdSchema,
});

export const listMyDocumentsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});
