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

// Búsquedas sensibles con sesión de baja confianza (p.ej. buscar cliente por RUT):
// acota el scrapeo de la cartera de crédito si se filtra un token de cajera.
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Demasiadas búsquedas, espera unos minutos" },
});
