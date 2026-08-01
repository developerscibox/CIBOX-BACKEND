import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

/**
 * Toma de pedido en sala (vendedor). Se vende POR CAJA; el cliente es opcional
 * (mostrador) y puede venir enlazado a un turno.
 */
export const takeOrderSchema = {
  body: z.object({
    items: z
      .array(
        z.object({
          product_id: objectId,
          cajas: z.coerce.number().int().min(1, "Mínimo 1 caja"),
        }),
      )
      .min(1, "El pedido debe tener al menos un producto"),
    customer: z
      .object({
        fullName: z.string().trim().optional(),
        name: z.string().trim().optional(),
        rut: z.string().trim().optional(),
        email: z.string().trim().email("Email inválido").optional().or(z.literal("")),
        phone: z.string().trim().optional(),
      })
      .optional()
      .default({}),
    turno_id: objectId.optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
};

/** Cobro de la cajera (relay etapa 2). "credito" exige cliente_rut (lo valida el
 *  servicio contra el estado de crédito); override solo lo honra admin/manager. */
export const cobrarSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    metodo: z.enum(["efectivo", "tarjeta", "transferencia", "credito"]).default("efectivo"),
    amount_received: z.coerce.number().int().min(0).optional(),
    cliente_rut: z.string().trim().min(1).optional(),
    override: z.boolean().optional(),
  }),
};

export default { takeOrderSchema, cobrarSchema };
