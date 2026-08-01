import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "password",
      "*.password",
      "password_hash",
      "*.password_hash",
      "token",
      "*.token",
      "authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "email_verification_token",
      "reset_password_token",
      "EMAIL_PASS",
      "JWT_SECRET",
      "JWT_REFRESH_SECRET",
      "GUEST_ID_SECRET",
      "WEBPAY_API_KEY",
      "S3_SECRET_KEY",
    ],
    censor: "[REDACTED]",
  },
  transport: env.isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
    : undefined,
});
