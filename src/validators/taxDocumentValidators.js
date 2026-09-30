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

/**
 * Fecha y hora en formato ISO, tal como la manda el navegador.
 *
 * Se aceptan las tres formas que llegan de verdad desde una pantalla:
 *   2026-09-29T14:30            (input datetime-local, sin zona ni segundos)
 *   2026-09-29T14:30:00.000Z    (Date.toISOString())
 *   2026-09-29T14:30:00-03:00   (con desfase horario)
 * Se rechaza cualquier otra cosa y también lo que parece fecha pero no existe
 * (por ejemplo 2026-02-31): si la fecha entrara corrupta, el documento quedaría
 * con una fecha de emisión que no coincide con la del portal del SII.
 */
const ISO_FECHA_HORA =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * El día escrito tiene que existir en el calendario. Va aparte porque
 * Date.parse NO avisa: "2026-02-31" lo corre solo al 3 de marzo, y así la
 * fecha de emisión quedaría distinta de la del documento real.
 */
const esDiaDeCalendario = (anio, mes, dia) => {
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
};

const fechaIsoSchema = z
  .string()
  .trim()
  .refine((valor) => {
    const partes = ISO_FECHA_HORA.exec(valor);
    if (!partes) return false;
    if (Number.isNaN(Date.parse(valor))) return false;
    return esDiaDeCalendario(Number(partes[1]), Number(partes[2]), Number(partes[3]));
  }, "Fecha inválida: se espera formato ISO (2026-09-29T14:30 o 2026-09-29T14:30:00.000Z)");

/**
 * Marcar a mano una boleta pendiente como ya emitida en el portal del SII.
 * El folio se guarda tal cual lo escribe la persona (solo recortado): es el
 * número que quedó impreso en el documento real y no nos toca reformatearlo.
 */
export const markEmittedSchema = z.object({
  folio: z
    .string({ required_error: "Folio requerido" })
    .trim()
    .min(1, "Folio requerido")
    .max(40, "El folio no puede pasar de 40 caracteres"),
  emitted_at: fechaIsoSchema.optional(),
});

export const listMyDocumentsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});
