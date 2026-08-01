import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID de producto inválido");

/**
 * Validación de la carga manual de ventas (venta presencial en bodega).
 * Se vende POR CAJA: cada item lleva cajas>=1; el servidor traduce a unidades.
 */
export const manualOrderSchema = {
  body: z.object({
    items: z
      .array(
        z.object({
          product_id: objectId,
          cajas: z.coerce.number().int().min(1, "Mínimo 1 caja"),
        }),
      )
      .min(1, "La venta debe tener al menos un producto"),
    customer: z.object({
      fullName: z.string().trim().min(1, "Nombre requerido"),
      rut: z.string().trim().optional(),
      email: z.string().trim().email("Email inválido").optional().or(z.literal("")),
      phone: z.string().trim().optional(),
    }),
    payment_method: z.enum(["cash_on_pickup", "transfer"]).default("cash_on_pickup"),
    status: z.enum(["paid", "delivered"]).default("delivered"),
    discountAmount: z.coerce.number().int().min(0).optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
};

export default { manualOrderSchema };
