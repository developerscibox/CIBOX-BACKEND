import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let transporter = null;

const buildTransporter = () => {
  if (!env.EMAIL_HOST || !env.EMAIL_USER || !env.EMAIL_PASS) {
    logger.warn(
      { host: !!env.EMAIL_HOST, user: !!env.EMAIL_USER, pass: !!env.EMAIL_PASS },
      "emailService: configuración SMTP incompleta — emails se descartarán"
    );
    return null;
  }

  return nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: env.EMAIL_PORT === 465,
    auth: {
      user: env.EMAIL_USER,
      pass: env.EMAIL_PASS,
    },
  });
};

const getTransporter = () => {
  if (transporter !== null) return transporter;
  transporter = buildTransporter();
  return transporter;
};

/**
 * Envía un correo. No lanza excepción al caller para no romper el flujo
 * de auth si el SMTP está caído — solo registra el error.
 */
export const sendEmail = async ({ to, subject, text, html }) => {
  if (!to) {
    logger.warn("sendEmail llamado sin destinatario");
    return { sent: false, reason: "no_recipient" };
  }

  const tx = getTransporter();
  if (!tx) {
    logger.warn({ to, subject }, "sendEmail: transporter no configurado, email omitido");
    return { sent: false, reason: "no_transporter" };
  }

  try {
    const info = await tx.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, subject, messageId: info.messageId }, "email enviado");
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    logger.error(
      { to, subject, err: { message: error.message, code: error.code } },
      "sendEmail falló"
    );
    return { sent: false, reason: "send_error" };
  }
};
