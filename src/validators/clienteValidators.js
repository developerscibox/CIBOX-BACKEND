import { z } from "zod";

import { isValidRut } from "../utils/rut.js";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");
const rutSchema = z
  .string()
  .trim()
  .refine((v) => isValidRut(v), "RUT inválido");

const contactoSchema = z
  .object({
    nombre: z.string().trim().max(120).optional(),
    telefono: z.string().trim().max(30).optional(),
    email: z.string().trim().email("Email inválido").optional().or(z.literal("")),
  })
  .optional();

/** Alta de cliente. El bloqueo NO se setea al crear (solo vía PATCH). */
export const createClienteSchema = {
  body: z.object({
    razon_social: z.string().trim().min(1, "Razón social requerida").max(200),
    rut: rutSchema,
    contacto: contactoSchema,
    credito: z
      .object({
        habilitado: z.boolean().optional(),
        linea: z.coerce.number().int().min(0).optional(),
        condicion_dias: z.coerce.number().int().min(0).max(365).optional(),
        dias_gracia: z.coerce.number().int().min(0).max(365).optional(),
      })
      .optional(),
    notas: z.string().trim().max(2000).optional(),
  }),
};

/** Edición de datos + crédito (linea/bloqueado quedan auditados). */
export const updateClienteSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    razon_social: z.string().trim().min(1).max(200).optional(),
    rut: rutSchema.optional(),
    contacto: contactoSchema,
    credito: z
      .object({
        habilitado: z.boolean().optional(),
        linea: z.coerce.number().int().min(0).optional(),
        condicion_dias: z.coerce.number().int().min(0).max(365).optional(),
        dias_gracia: z.coerce.number().int().min(0).max(365).optional(),
        bloqueado: z.boolean().optional(),
        bloqueo_motivo: z.string().trim().max(300).optional(),
      })
      .optional(),
    notas: z.string().trim().max(2000).optional(),
    activo: z.boolean().optional(),
  }),
};

export const clienteIdSchema = {
  params: z.object({ id: objectId }),
};

/** Abono FIFO sobre las deudas pendientes del cliente. */
export const abonoClienteSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    monto: z.coerce.number().positive("monto debe ser mayor a 0"),
    medio: z.enum(["efectivo", "transferencia", "cheque"]).optional().default("efectivo"),
    referencia: z.string().trim().max(200).optional(),
  }),
};

/** Búsqueda por RUT (cajera) — 422 si el RUT es inválido. */
export const buscarRutSchema = {
  params: z.object({ rut: rutSchema }),
};

export default {
  createClienteSchema,
  updateClienteSchema,
  clienteIdSchema,
  abonoClienteSchema,
  buscarRutSchema,
};
