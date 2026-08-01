import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

/** POST /autorizaciones/solicitar (cajera) */
export const solicitarAutorizacionSchema = {
  body: z
    .object({
      order_id: objectId,
      tipo: z.enum(["anulacion", "precio"]),
      detalle: z
        .string()
        .trim()
        .min(1, "El motivo es requerido")
        .max(300, "Máximo 300 caracteres"),
      // Solo tipo="precio": nuevos precios UNITARIOS propuestos por ítem.
      cambios: z
        .array(
          z.object({
            product_id: objectId,
            precio_propuesto: z.coerce.number().int().positive("Precio inválido"),
          }),
        )
        .min(1)
        .max(30)
        .optional(),
    })
    .refine((b) => b.tipo !== "precio" || (b.cambios && b.cambios.length > 0), {
      message: "Una excepción de precio requiere al menos un ítem con precio propuesto",
      path: ["cambios"],
    }),
};

/** GET /autorizaciones?estado=pendiente|todas (jefe) */
export const listarAutorizacionesSchema = {
  query: z.object({
    estado: z.enum(["pendiente", "todas"]).default("pendiente"),
  }),
};

/** GET /autorizaciones/pedido/:orderId (cajera) */
export const autorizacionDePedidoSchema = {
  params: z.object({ orderId: objectId }),
};

/** POST /autorizaciones/:id/resolver (jefe) */
export const resolverAutorizacionSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    aprobar: z.boolean(),
    nota: z.string().trim().max(300, "Máximo 300 caracteres").optional(),
  }),
};

export default {
  solicitarAutorizacionSchema,
  listarAutorizacionesSchema,
  autorizacionDePedidoSchema,
  resolverAutorizacionSchema,
};
