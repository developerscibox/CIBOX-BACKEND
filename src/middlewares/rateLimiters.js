import rateLimit from "express-rate-limit";

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Demasiadas solicitudes, intenta más tarde" },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, code: "AUTH_RATE_LIMIT", message: "Demasiados intentos de autenticación, espera 15 minutos" },
});

export const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "EMAIL_RATE_LIMIT", message: "Demasiados correos enviados, intenta más tarde" },
});

export const guestOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Demasiadas consultas de orden" },
});

// Tableros PÚBLICOS polleados de forma continua (pantalla de retiros, turnos y
// seguimiento del turno propio). Un TV consulta cada ~8s y varios clientes
// pueden compartir la IP del local (NAT): el límite es alto pero acota el abuso.
export const boardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Demasiadas consultas del tablero" },
});

export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "PAYMENT_RATE_LIMIT", message: "Demasiadas solicitudes de pago, intenta más tarde" },
});

// Validación de cupones: acota la fuerza bruta de códigos de descuento.
export const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Demasiados intentos de cupón, espera unos minutos" },
});

// Consulta PÚBLICA del seguimiento de un pedido (folio + correo). Es el único
// endpoint donde un desconocido puede adivinar: el folio son 6 caracteres y el
// correo de una persona se supone. Sin límite propio, lo único que aplicaba era
// el globalLimiter de 600/15min, o sea 600 intentos por ventana y por IP.
//
// Molde: authLimiter, que es el único que ya pelea contra fuerza bruta sobre un
// secreto. Pero con CUPO PROPIO y no reutilizándolo: compartir el del login haría
// que unas cuantas consultas falladas dejaran sin poder entrar a su cuenta a toda
// la gente que sale por la misma IP (el wifi del local, el NAT del celular).
//
// skipSuccessfulRequests es lo que hace que la medida no moleste al que sí es
// dueño del pedido: quien acierta y después refresca su seguimiento no gasta
// intentos. Solo cuentan los FALLOS, que es exactamente lo que hace el que prueba.
export const trackingLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    code: "TOO_MANY_REQUESTS",
    message:
      "Demasiados intentos de consulta. Espera 15 minutos y vuelve a intentarlo.",
  },
});

// Búsquedas sensibles con sesión de baja confianza (p.ej. buscar cliente por RUT):
// acota el scrapeo de la cartera de crédito si se filtra un token de cajera.
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Demasiadas búsquedas, espera unos minutos" },
});
