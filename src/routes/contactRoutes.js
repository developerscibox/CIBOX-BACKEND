import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";
import { contactLimiter } from "../middlewares/rateLimiters.js";
import { contactMessageSchema } from "../validators/contactValidators.js";
import { enviarMensajeDeContacto } from "../controllers/contactController.js";

const router = Router();

/**
 * POST /api/contact — formulario público "Contáctanos".
 *
 * `optionalAuth` y no `protect`: el formulario es para cualquiera, con cuenta o
 * sin ella. Si hay sesión, el mensaje queda vinculado a la persona; si no, se
 * guarda igual.
 *
 * El limitador va ANTES de validar, por lo mismo que en el seguimiento público:
 * si validara primero, los cuerpos malformados saldrían gratis y quien quiera
 * inundar la bandeja tendría una vía sin costo.
 *
 * `contactLimiter` es propio y no el de correos: compartirlo con
 * forgot-password dejaría a quien escribió por el formulario sin poder
 * recuperar su contraseña ese mismo día. Ese error ya se pagó una vez con las
 * rutas de sesión.
 */
router.post(
  "/",
  contactLimiter,
  optionalAuth,
  validate({ body: contactMessageSchema }),
  enviarMensajeDeContacto,
);

export default router;
