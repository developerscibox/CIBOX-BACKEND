import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "../utils/constants.js";
import { isValidRut } from "../utils/rut.js";

const emailSchema = z
  .string({ required_error: "Email requerido" })
  .trim()
  .toLowerCase()
  .email("Email inválido")
  .max(254, "Email demasiado largo");

const passwordSchema = z
  .string({ required_error: "Contraseña requerida" })
  .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(128, "Contraseña demasiado larga");

const nameSchema = z
  .string({ required_error: "Nombre requerido" })
  .trim()
  .min(2, "Nombre demasiado corto")
  .max(100, "Nombre demasiado largo");

const phoneSchema = z
  .string()
  .trim()
  .max(30, "Teléfono demasiado largo")
  .optional()
  .nullable();

const rutSchema = z
  .string()
  .trim()
  .max(15, "RUT demasiado largo")
  .refine((v) => !v || isValidRut(v), { message: "RUT inválido" })
  .optional()
  .nullable();

const tokenSchema = z
  .string({ required_error: "Token requerido" })
  .trim()
  .min(16, "Token inválido")
  .max(512, "Token inválido");

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema,
  rut: rutSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ required_error: "Contraseña requerida" }).min(1, "Contraseña requerida"),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: tokenSchema,
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: tokenSchema,
});

export const resendVerificationSchema = z.object({
  email: emailSchema,
});

// El refresh token puede venir en el body (app nativa, desarrollo) o en la
// cookie httpOnly (tienda y panel web en producción). Cuando viene en la
// cookie el body llega vacío, así que acá es opcional: el controlador lee
// cookie O body, y el servicio rechaza con 401 si no hay ninguno.
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(10, "refreshToken inválido").optional(),
});

export const updateProfileSchema = z
  .object({
    name: nameSchema.optional(),
    phone: phoneSchema,
    rut: rutSchema,
  })
  .refine(
    (data) =>
      data.name !== undefined || data.phone !== undefined || data.rut !== undefined,
    { message: "Debes enviar al menos un campo a actualizar" }
  );

export const changePasswordSchema = z.object({
  currentPassword: z.string({ required_error: "Contraseña actual requerida" }).min(1),
  newPassword: passwordSchema,
});
