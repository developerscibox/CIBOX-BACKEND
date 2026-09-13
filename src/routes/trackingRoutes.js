import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";
import { trackingLookupLimiter } from "../middlewares/rateLimiters.js";
import {
  trackingParamsSchema,
  trackingQuerySchema,
  trackingLookupSchema,
  blueexpressWebhookSchema,
} from "../validators/trackingValidators.js";
import {
  getPublicTracking,
  lookupPublicTracking,
  blueexpressWebhook,
} from "../controllers/trackingController.js";

const router = Router();

router.get(
  "/orders/:id",
  optionalAuth,
  validate({ params: trackingParamsSchema, query: trackingQuerySchema }),
  getPublicTracking
);

/**
 * Consulta pública del seguimiento: número de pedido + correo con el que se
 * compró. Existe para el que compró SIN CUENTA y vuelve después.
 *
 * Va por POST y no por GET porque el correo NO puede viajar en la URL: de ahí
 * pasa al historial del navegador, a los logs del proxy y a la cabecera Referer.
 *
 * El limitador va ANTES de validar, y no al revés: si validara primero, los
 * cuerpos malformados no gastarían intentos y el que prueba a lo bruto tendría
 * una forma gratis de sondear. Con `skipSuccessfulRequests` en el limitador, al
 * cliente legítimo que refresca su seguimiento esto no le cuesta nada.
 */
router.post(
  "/lookup",
  trackingLookupLimiter,
  validate({ body: trackingLookupSchema }),
  lookupPublicTracking
);

router.post(
  "/webhooks/blueexpress",
  validate({ body: blueexpressWebhookSchema }),
  blueexpressWebhook
);

export default router;
