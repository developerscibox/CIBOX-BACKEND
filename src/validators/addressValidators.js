import { z } from "zod";
import { isValidRut } from "../utils/rut.js";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

const rutOpt = z
  .string()
  .trim()
  .max(15)
  .refine((v) => !v || isValidRut(v), { message: "RUT inválido" })
  .optional()
  .default("");

export const createAddressSchema = z.object({
  label: z.string().trim().max(60).optional().default(""),
  full_name: z.string().trim().min(2, "Nombre requerido").max(120),
  phone: z.string().trim().max(30).optional().default(""),
  rut: rutOpt,
  street: z.string().trim().min(2, "Calle requerida").max(200),
  number: z.string().trim().max(30).optional().default(""),
  apartment: z.string().trim().max(60).optional().default(""),
  commune: z.string().trim().min(2, "Comuna requerida").max(100),
  region: z.string().trim().min(2, "Región requerida").max(100),
  postal_code: z.string().trim().max(20).optional().default(""),
  is_default: z.coerce.boolean().optional().default(false),
});

export const updateAddressSchema = createAddressSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: "Debes enviar al menos un campo a actualizar" }
);

export const addressIdParamsSchema = z.object({
  id: objectIdSchema,
});
