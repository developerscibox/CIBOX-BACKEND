import { z } from "zod";

/**
 * Formulario público "Contáctanos".
 *
 * Los topes de largo no son decorativos: el formulario es público y sin sesión,
 * así que es el sitio natural para que alguien pegue un texto enorme. El modelo
 * repite los mismos máximos, porque validar dos veces cuesta poco y quedarse
 * sin la segunda barrera cuesta caro.
 */
export const contactMessageSchema = z.object({
  nombre: z
    .string({ required_error: "Necesitamos tu nombre" })
    .trim()
    .min(2, "Escribe tu nombre")
    .max(120, "El nombre es demasiado largo"),

  email: z
    .string({ required_error: "Necesitamos tu correo" })
    .trim()
    .toLowerCase()
    .email("Revisa el correo: no parece una dirección válida")
    .max(160, "El correo es demasiado largo"),

  // Opcional a propósito: pedir teléfono obligatorio espanta a quien solo
  // quiere hacer una pregunta.
  telefono: z
    .string()
    .trim()
    .max(40, "El teléfono es demasiado largo")
    .optional()
    .or(z.literal("")),

  asunto: z.string().trim().max(160, "El asunto es demasiado largo").optional().or(z.literal("")),

  mensaje: z
    .string({ required_error: "Escribe tu mensaje" })
    .trim()
    .min(10, "Cuéntanos un poco más: al menos 10 caracteres")
    .max(5000, "El mensaje es demasiado largo"),
});
