import ContactMessage from "../models/ContactMessage.js";
import { sendEmail } from "../services/emailService.js";
import {
  buildContactMessageTemplate,
  buildContactAckTemplate,
} from "../utils/emailTemplates.js";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * POST /api/contact — formulario público "Contáctanos".
 *
 * ORDEN DELIBERADO: primero se GUARDA, después se avisa por correo.
 *
 * Antes el formulario no tocaba el servidor: armaba un `mailto:` y abría el
 * programa de correo del visitante. En un navegador sin cliente configurado
 * —lo normal en escritorio— no ocurría nada y el mensaje se perdía en
 * silencio, sin que ni la persona ni Cibox se enteraran.
 *
 * Ahora el correo es el AVISO, no el almacén. Si Resend falla, si la casilla de
 * destino no existe o si alguien se equivoca al configurarla, el mensaje sigue
 * guardado y se puede leer y responder. Por eso el envío va en try/catch y
 * nunca tumba la respuesta: la persona ya cumplió su parte.
 */
export const enviarMensajeDeContacto = asyncHandler(async (req, res) => {
  const { nombre, email, telefono, asunto, mensaje } = req.body;

  const guardado = await ContactMessage.create({
    nombre,
    email,
    telefono: telefono || null,
    asunto: asunto || "",
    mensaje,
    user_id: req.user?.id || null,
    origen_ip: req.ip || null,
  });

  const folio = String(guardado._id).slice(-6).toUpperCase();
  let emailEnviado = false;

  // 1) Aviso al equipo. `replyTo` apunta a quien escribió: así se responde con
  //    el botón "Responder" y el correo le llega a la persona directamente,
  //    sin copiar la dirección a mano.
  try {
    const tpl = buildContactMessageTemplate({ mensaje: guardado });
    // `sendEmail` no lanza cuando no hay transporte configurado: devuelve
    // `{ sent: false }` y lo registra. Hay que mirar ESE valor, porque si no
    // el mensaje quedaría marcado como avisado sin que saliera nada.
    const envio = await sendEmail({
      to: destinatarioDelEquipo(),
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
      replyTo: email,
    });
    emailEnviado = Boolean(envio?.sent);
  } catch (err) {
    logger.warn(
      { err: err.message, contactId: String(guardado._id) },
      "contacto: no se pudo avisar al equipo (el mensaje SÍ quedó guardado)",
    );
  }

  // 2) Acuse a quien escribió. Sin esto la persona no sabe si su mensaje salió
  //    y vuelve a mandarlo, o llama. No bloquea: es cortesía, no el trámite.
  try {
    const ack = buildContactAckTemplate({ mensaje: guardado });
    await sendEmail({ to: email, subject: ack.subject, text: ack.text, html: ack.html });
  } catch (err) {
    logger.warn({ err: err.message }, "contacto: no se pudo enviar el acuse al cliente");
  }

  if (emailEnviado) {
    ContactMessage.updateOne({ _id: guardado._id }, { $set: { email_enviado: true } }).catch(
      () => {},
    );
  }

  logger.info({ contactId: String(guardado._id), folio, emailEnviado }, "contacto: mensaje recibido");

  return res.status(201).json({
    success: true,
    data: {
      folio,
      mensaje: "Recibimos tu mensaje. Te responderemos al correo que nos dejaste.",
    },
  });
});

/**
 * Casilla del equipo que recibe los mensajes.
 *
 * Sale de `CONTACT_INBOX` para poder cambiarla sin tocar código ni volver a
 * desplegar la tienda. El valor por defecto es la casilla que HOY recibe de
 * verdad los avisos internos de compra; apuntar a una dirección que todavía no
 * existe en el proveedor de correo haría rebotar cada mensaje.
 */
const destinatarioDelEquipo = () =>
  String(env.CONTACT_INBOX || "").trim() || "developers@cibox.cl";
