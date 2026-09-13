import { z } from "zod";
import { isValidRut } from "../utils/rut.js";
import {
  zonaDeDespacho,
  esRegionDeReparto,
  REGION_REPARTO,
} from "../config/despacho.js";

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

/**
 * Una dirección guardada solo sirve si se le puede despachar. Se valida la zona
 * acá para avisar al momento de guardarla y no en el checkout, cuando la
 * persona ya llenó todo el formulario y eligió los productos.
 *
 * Ojo: esto NO borra ni migra las direcciones que ya estaban guardadas fuera de
 * zona. Solo impide crear o editar hacia una comuna sin reparto.
 */
const validarZonaDeReparto = (data, ctx) => {
  // En la edición parcial pueden venir uno, otro o ninguno de los dos campos.
  if (data.commune === undefined && data.region === undefined) return;

  // Edición que solo toca la región: sin comuna no hay nada que cruzar, pero la
  // región tiene que seguir siendo la que tiene reparto.
  if (data.commune === undefined) {
    if (!esRegionDeReparto(data.region)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["region"],
        message: `Solo despachamos en la ${REGION_REPARTO}`,
      });
    }
    return;
  }

  const zona = zonaDeDespacho({ region: data.region, comuna: data.commune });
  if (zona.ok) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    // "city" es el nombre del campo en el checkout; acá el campo se llama
    // "commune". Se apunta al que existe en este formulario.
    path: [zona.campo === "region" ? "region" : "commune"],
    message: zona.mensaje,
  });
};

const addressFields = z.object({
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

export const createAddressSchema = addressFields.superRefine(validarZonaDeReparto);

export const updateAddressSchema = addressFields
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debes enviar al menos un campo a actualizar",
  })
  .superRefine(validarZonaDeReparto);

export const addressIdParamsSchema = z.object({
  id: objectIdSchema,
});
