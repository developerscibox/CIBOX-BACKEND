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

/**
 * Consulta pública del seguimiento: número de pedido + correo con el que se
 * compró. Van en el CUERPO de un POST y no en la query de un GET a propósito —
 * el correo no puede terminar en la URL, porque de ahí pasa al historial del
 * navegador, a los logs del proxy y a la cabecera Referer.
 *
 * El folio se acepta suelto (el cliente escribe "#A1B2C3", "a1 b2 c3" o pega el
 * id completo de 24 que ve en la URL de su pedido): la limpieza y el calce los
 * hace el servicio. Aquí solo se acota el largo para no aceptar basura.
 */
export const trackingLookupSchema = z.object({
  folio: z
    .string({ required_error: "Ingresa el número de tu pedido" })
    .trim()
    .min(4, "El número de pedido es muy corto")
    .max(32, "El número de pedido es muy largo"),
  email: z
    .string({ required_error: "Ingresa el correo con el que compraste" })
    .trim()
    .toLowerCase()
    .email("Revisa el correo")
    .max(254),
});

export const blueexpressWebhookSchema = z.object({
  tracking_number: z.string().trim().min(1).optional(),
  trackingNumber: z.string().trim().min(1).optional(),
  guide: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  shipment_status: z.string().trim().min(1).optional(),
}).passthrough();
