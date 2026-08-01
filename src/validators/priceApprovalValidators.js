import { z } from "zod";

const tierSchema = z.object({
  min_qty: z.coerce.number().int().min(1),
  price: z.coerce.number().min(1),
  label: z.string().optional(),
});

export const solicitarCambioPrecioSchema = {
  body: z.object({
    items: z
      .array(
        z.object({
          product_id: z.string().regex(/^[a-f0-9]{24}$/i, "product_id inválido"),
          tiers_propuestos: z.array(tierSchema).min(1),
        }),
      )
      .min(1, "Debe incluir al menos un producto"),
    motivo: z.string().max(300).optional(),
  }),
};

export const listarCambiosPrecioSchema = {
  query: z.object({
    estado: z.enum(["pendiente", "todas"]).optional(),
  }),
};

export const idParamSchema = {
  params: z.object({
    id: z.string().regex(/^[a-f0-9]{24}$/i, "id inválido"),
  }),
};
