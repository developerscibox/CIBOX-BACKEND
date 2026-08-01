import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  UPLOAD_DRIVER: z.enum(["disk", "s3", "cloudinary"]).default("disk"),
  PANTRY_DISCOUNT: z.coerce.number().min(0).max(100).default(10),
  CIBOX_PLUS_DISCOUNT: z.coerce.number().min(0).max(100).default(15),
  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),
  CLOUDINARY_FOLDER: z.string().default("cibox/products"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  MONGO_URI: z.string().min(1, "MONGO_URI requerido"),

  // Expiración de órdenes pendientes de pago (repone stock retenido)
  ORDER_PENDING_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  ORDER_EXPIRY_CHECK_MINUTES: z.coerce.number().int().positive().default(10),

  // Reserva de stock del carrito: TTL de la retención y cada cuánto barre el
  // job de liberación las reservas vencidas (decrementa Product.reserved).
  CART_RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(20),
  CART_RESERVATION_SWEEP_MINUTES: z.coerce.number().int().positive().default(2),

  ALLOWED_ORIGINS: z.string().default(""),

  // Módulos comerciales activos (csv): web, bodega, sala, gerencia.
  // Los frontends consultan GET /api/config/modules para ocultar lo no contratado.
  MODULES_ENABLED: z.string().default("web,bodega,sala,gerencia"),

  // Bootstrap OPCIONAL de cuentas operativas del relay al arrancar. Desactivado
  // por defecto: en producción NO se crea ningún usuario salvo que se active
  // explícitamente Y se provea una contraseña (nunca hardcodeada en el código).
  SEED_RELAY_USERS: z.coerce.boolean().default(false),
  SEED_RELAY_PASSWORD: z.string().default(""),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT_REFRESH_SECRET debe tener al menos 32 caracteres"),
  JWT_ACCESS_EXPIRES: z.string().default("1h"),
  JWT_REFRESH_EXPIRES: z.string().default("30d"),

  GUEST_ID_SECRET: z
    .string()
    .min(32, "GUEST_ID_SECRET debe tener al menos 32 caracteres"),

  EMAIL_HOST: z.string().default(""),
  EMAIL_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_USER: z.string().default(""),
  EMAIL_PASS: z.string().default(""),
  EMAIL_FROM: z.string().default("Cibox <no-reply@cibox.cl>"),

  // Datos bancarios (texto multilínea) para el email de pedidos por
  // transferencia. Opcional: sin setear, el email indica pedirlos por WhatsApp.
  BANK_TRANSFER_INFO: z.string().default(""),

  WEBPAY_ENV: z.enum(["integration", "production"]).default("integration"),
  WEBPAY_COMMERCE_CODE: z.string().default(""),
  WEBPAY_API_KEY: z.string().default(""),
  WEBPAY_RETURN_URL: z
    .string()
    .default("http://localhost:3000/api/payments/webpay/return"),

  FRONTEND_URL: z.string().default("http://localhost:5173"),
  MOBILE_DEEP_LINK: z.string().default("myapp://"),

  BLUEEXPRESS_API_URL: z.string().default(""),
  BLUEEXPRESS_API_KEY: z.string().default(""),
  BLUEEXPRESS_ACCOUNT: z.string().default(""),

  SII_ENABLED: z.coerce.boolean().default(false),
  SII_ENV: z.enum(["certification", "production"]).default("certification"),
  SII_RUT_EMPRESA: z.string().default(""),
  SII_CERT_PATH: z.string().default(""),
  SII_CERT_PASSWORD: z.string().default(""),

  // Bot de Telegram para aprobación de cambios de precio. Sin token, el módulo
  // queda desactivado (Precios sigue en modo directo).
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_GROUP_CHAT_ID: z.string().default(""),
  TELEGRAM_APPROVER_IDS: z.string().default(""), // csv de IDs de Telegram (semilla)
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""), // reservado para webhook en prod

  UPLOAD_DISK_PATH: z.string().default("./uploads"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_KEY: z.string().default(""),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().default(""),
  S3_PUBLIC_URL: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Variables de entorno inválidas:");
  for (const issue of parsed.error.issues) {
    console.error(` - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const isProd = parsed.data.NODE_ENV === "production";

if (isProd) {
  if (
    parsed.data.WEBPAY_ENV === "production" &&
    (!parsed.data.WEBPAY_COMMERCE_CODE || !parsed.data.WEBPAY_API_KEY)
  ) {
    console.error(
      "❌ WEBPAY_COMMERCE_CODE y WEBPAY_API_KEY son obligatorios en producción",
    );
    process.exit(1);
  }
  if (!parsed.data.ALLOWED_ORIGINS) {
    console.error("❌ ALLOWED_ORIGINS es obligatorio en producción");
    process.exit(1);
  }
}

// Aviso de configuración cruzada de integraciones OPCIONALES. Se ADVIERTE pero NO se
// aborta: una integración a medio configurar degrada (p. ej. SII cae a stub, el
// correo no se envía) pero jamás debe tumbar un servicio en marcha. Los secretos
// realmente obligatorios (JWT/Mongo/guest) ya los exige el esquema Zod de arriba.
if (parsed.data.SII_ENABLED) {
  const faltan = ["SII_RUT_EMPRESA", "SII_CERT_PATH", "SII_CERT_PASSWORD"].filter((k) => !parsed.data[k]);
  if (faltan.length) {
    console.warn(`⚠️  SII_ENABLED=true pero faltan ${faltan.join(", ")} — la emisión real no funcionará (documentos en stub).`);
  }
}
if (parsed.data.EMAIL_HOST && (!parsed.data.EMAIL_USER || !parsed.data.EMAIL_PASS)) {
  console.warn("⚠️  EMAIL_HOST configurado pero faltan EMAIL_USER/EMAIL_PASS — el envío de correos fallará.");
}

export const env = {
  ...parsed.data,
  isProd,
  isDev: parsed.data.NODE_ENV === "development",
  isTest: parsed.data.NODE_ENV === "test",
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  modulesEnabled: parsed.data.MODULES_ENABLED.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
