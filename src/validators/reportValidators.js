import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

// Fecha ISO con offset o YYYY-MM-DD (misma convención que inventoryValidators).
const isoDate = z.union([z.string().datetime({ offset: true }), z.string().date()]);

export const kardexValorizadoSchema = {
  query: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    product_id: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
};

export const rotacionSchema = {
  query: z.object({
    days: z.coerce.number().int().min(1).max(365).optional(),
  }),
};

export const rankingSchema = {
  query: z.object({
    by: z.enum(["vendedor", "producto", "cliente"]).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export const margenSchema = {
  query: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  }),
};

export const libroVentasSchema = {
  query: z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "month debe ser YYYY-MM")
      .optional(),
  }),
};

export const cuadresSchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};
