import { z } from "zod";

import { isValidRut } from "../utils/rut.js";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID de turno inválido");

const rutSchema = z
  .string()
  .trim()
  .min(7, "RUT demasiado corto")
  .max(15, "RUT demasiado largo")
  .refine((v) => isValidRut(v), { message: "RUT inválido" });

/** Cliente saca número desde el QR/kiosko: nombre, motivo y RUT opcionales. */
export const createTurnoSchema = {
  body: z.object({
    name: z.string().trim().max(80).optional(),
    tipo: z.enum(["compra", "retiro"]).optional(),
    rut: rutSchema.optional(),
  }),
};

/** Kiosko: consulta pública de pedidos de retiro por RUT. */
export const pedidosPorRutSchema = {
  params: z.object({ rut: rutSchema }),
};

export const turnoIdParamSchema = {
  params: z.object({ id: objectId }),
};

/** Llamar al siguiente: módulo opcional (nombre del mostrador) + fila opcional
 *  ("compra" = tienda, "retiro" = pedidos de internet). Sin tipo llama cualquiera. */
export const callNextSchema = {
  body: z.object({
    module: z.string().trim().max(40).optional(),
    tipo: z.enum(["compra", "retiro"]).optional(),
  }),
};

/** Config de módulos de atención. */
export const moduleCreateSchema = {
  body: z.object({ name: z.string().trim().min(1, "Nombre requerido").max(40) }),
};

export const moduleUpdateSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().trim().min(1).max(40).optional(),
    active: z.boolean().optional(),
  }),
};

export const moduleIdParamSchema = {
  params: z.object({ id: objectId }),
};

export default {
  createTurnoSchema,
  pedidosPorRutSchema,
  turnoIdParamSchema,
  callNextSchema,
  moduleCreateSchema,
  moduleUpdateSchema,
  moduleIdParamSchema,
};
