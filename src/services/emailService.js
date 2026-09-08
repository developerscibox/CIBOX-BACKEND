import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// `resend` se carga con import() dinámico, no arriba con el resto.
//
// Este módulo cuelga de la cadena de arranque (app.js → orderRoutes →
// orderController → aquí), así que un import estático lo vuelve obligatorio para
// que el proceso levante: si el droplet despliega con `git pull` + `pm2 restart`
// y se olvida el `npm install`, Node aborta con ERR_MODULE_NOT_FOUND antes de
// abrir Express y pm2 entra en bucle de reinicio. Es decir, un despiste en el
// despliegue del correo tumbaría la TIENDA ENTERA.
//
// Cargándolo aquí dentro, el peor caso vuelve a ser el que corresponde: no salen
// los correos, y el log dice que falta instalar la dependencia.
let cargarResend = async () => {
  const mod = await import("resend");
  return mod.Resend;
};

/**
 * POR QUÉ ESTE ARCHIVO NO USA SMTP EN PRODUCCIÓN
 *
 * El droplet donde corre Cibox está en DigitalOcean, y DigitalOcean bloquea de
 * salida los puertos SMTP (25, 465 y 587) como política antispam. Está
 * comprobado abriendo sockets contra la IP de Gmail: los tres dan timeout, y en
 * pm2 eso se veía como decenas de "sendEmail falló" con ETIMEDOUT/ENETUNREACH.
 * El puerto 443 sí sale sin problemas.
 *
 * Por eso el camino de producción es Resend, que es una API HTTPS. Si alguien
 * "arregla" esto devolviéndolo a SMTP, el correo vuelve a caerse entero y el
 * síntoma es el mismo de siempre: ningún cliente recibe verificación de cuenta,
 * restablecimiento de contraseña ni avisos de pedido.
 *
 * SMTP se queda porque en desarrollo local sí funciona (ahí no hay bloqueo) y
 * evita tener que repartir la clave de Resend entre las máquinas del equipo.
 *
 * La elección es por entorno y se hace UNA sola vez, no es una cadena de
 * respaldo: reintentar por SMTP cuando Resend falla añadiría ~2 minutos de
 * timeout de nodemailer a cada correo, colgando el registro y el checkout con
 * un respaldo que en el droplet está garantizado que va a fallar.
 */

let resendClient = null;
let smtpTransporter = null;

const buildSmtpTransporter = () => {
  if (!env.EMAIL_HOST || !env.EMAIL_USER || !env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: env.EMAIL_PORT === 465,
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
  });
};

const smtpConfigurado = () =>
  Boolean(env.EMAIL_HOST && env.EMAIL_USER && env.EMAIL_PASS);

/**
 * Decide la vía una vez al arrancar. EMAIL_TRANSPORT distinto de "auto" manda,
 * para poder forzar una vía en pruebas sin tocar el resto del .env.
 */
const elegirVia = () => {
  if (env.EMAIL_TRANSPORT === "off") return "none";
  if (env.EMAIL_TRANSPORT === "resend") return env.RESEND_API_KEY ? "resend" : "none";
  if (env.EMAIL_TRANSPORT === "smtp") return smtpConfigurado() ? "smtp" : "none";

  // En automático, producción y desarrollo eligen al revés a propósito.
  //
  // En producción, SMTP no es una alternativa peor: es una que NO funciona, y
  // encima cuelga ~2 minutos por correo dentro del handler HTTP mientras espera
  // el timeout, con el registro y el checkout esperando detrás. Sin clave de
  // Resend es preferible descartar el correo y decirlo, que es lo que hace
  // "none".
  if (env.isProd) return env.RESEND_API_KEY ? "resend" : "none";

  // En local manda SMTP aunque haya clave de Resend. Quien copie el .env de
  // producción a su máquina —que es lo normal— si no, empezaría a mandar correos
  // DE VERDAD desde su equipo a direcciones reales sin enterarse.
  if (smtpConfigurado()) return "smtp";
  if (env.RESEND_API_KEY) return "resend";
  return "none";
};

const via = elegirVia();

// Dejar escrito en el log qué vía quedó activa. Sin esto hay que adivinar por
// qué no llega un correo, que es exactamente donde se perdió tiempo antes.
//
// Va en `warn` y no en `info` a propósito: el .env de producción corre con
// LOG_LEVEL=warn, así que en `info` esta línea —que es justamente la que hay que
// leer cuando el correo no llega— no se imprimiría nunca donde hace falta.
if (via === "resend") {
  logger.warn(
    { from: env.RESEND_FROM || env.EMAIL_FROM },
    "emailService: enviando por Resend (HTTPS). Es la única vía que funciona en el droplet: DigitalOcean bloquea los puertos SMTP salientes.",
  );
} else if (via === "smtp") {
  smtpTransporter = buildSmtpTransporter();
  logger.warn(
    { host: env.EMAIL_HOST, port: env.EMAIL_PORT, from: env.EMAIL_FROM },
    "emailService: enviando por SMTP (desarrollo local).",
  );
} else {
  logger.warn(
    { EMAIL_TRANSPORT: env.EMAIL_TRANSPORT },
    "emailService: sin transporte configurado — los correos se descartan. Falta RESEND_API_KEY (producción) o EMAIL_HOST/USER/PASS (local).",
  );
}

// El bloque de instrucciones del sandbox es largo; se emite completo la primera
// vez y después se degrada a warn para no inundar pm2 con el mismo párrafo en
// cada correo.
let sandboxYaExplicado = false;

const explicarSandbox = ({ to, from, mensaje, statusCode }) => {
  if (sandboxYaExplicado) {
    logger.warn({ to, from, statusCode }, "Resend rechaza el envío: el dominio del remitente sigue sin verificar.");
    return;
  }
  sandboxYaExplicado = true;
  logger.error(
    { to, from, statusCode, resend: mensaje },
    "Resend está en modo sandbox: solo entrega a la casilla del dueño de la cuenta, cualquier otro destinatario se rechaza. " +
      "ACCIÓN DEL OPERADOR: entrar a https://resend.com/domains, verificar el dominio cibox.cl publicando los registros DNS que entrega el panel, " +
      "y luego dejar el remitente de EMAIL_FROM en ese dominio (y borrar RESEND_FROM del .env, que hoy apunta al remitente de prueba). " +
      "Hasta que eso esté hecho ningún cliente va a recibir correo, aunque el envío salga del servidor sin errores de red.",
  );
};

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cliente de Resend, creado la primera vez que hace falta.
 *
 * Se construye aquí y no al arrancar porque el paquete se carga con import()
 * dinámico (ver la cabecera): si falta en node_modules, esto devuelve null y el
 * correo se descarta con un log claro, en vez de impedir que el backend levante.
 */
const obtenerResend = async () => {
  if (resendClient) return resendClient;
  try {
    const Resend = await cargarResend();
    resendClient = new Resend(env.RESEND_API_KEY);
    return resendClient;
  } catch (err) {
    logger.error(
      { err: { message: err.message, code: err.code } },
      "emailService: falta la dependencia 'resend'. Corre `npm install` en el servidor; hasta entonces no sale ningún correo.",
    );
    return null;
  }
};

/**
 * Deja los destinatarios como el arreglo de direcciones sueltas que espera Resend.
 *
 * Varios destinatarios en UNA sola cadena separada por comas es válido en SMTP y
 * los llamadores lo usan: paymentController manda la notificación interna con
 * `recipients.join(",")`. Resend, en cambio, valida cada elemento del arreglo
 * como una dirección independiente, así que esa cadena hay que partirla. Sin
 * esto la API rechaza el envío completo con un 422 y la notificación de compra
 * pagada no le llega a nadie.
 *
 * Se exporta solo para poder probarlo: es el detalle que ya rompió el envío una
 * vez y no se ve a simple vista en ningún punto de llamada.
 */
export const normalizarDestinatarios = (to) =>
  (Array.isArray(to) ? to : String(to ?? "").split(","))
    .map((d) => String(d).trim())
    .filter(Boolean);

const enviarPorResend = async ({ to, subject, text, html }) => {
  const cliente = await obtenerResend();
  if (!cliente) return { sent: false, reason: "resend_no_instalado" };

  const from = env.RESEND_FROM || env.EMAIL_FROM;
  const destinatarios = normalizarDestinatarios(to);
  if (!destinatarios.length) {
    logger.warn({ subject }, "sendEmail: destinatario vacío tras normalizar");
    return { sent: false, reason: "no_recipient" };
  }
  // Resend rechaza las claves con valor nulo, así que el payload se arma solo
  // con lo que realmente viene.
  const payload = { from, to: destinatarios, subject };
  if (html) payload.html = html;
  if (text) payload.text = text;

  for (let intento = 1; intento <= 2; intento += 1) {
    let data;
    let error;
    try {
      // Con tope de 10 s: ni el SDK ni undici ponen uno corto (el de undici es
      // de 5 minutos), y `sendEmail` se espera DENTRO de los handlers de pedido
      // y de pago. Sin esto, una petición colgada a Resend deja al cliente
      // mirando el navegador hasta cinco minutos por un correo.
      ({ data, error } = await cliente.emails.send(payload, {
        signal: AbortSignal.timeout(10_000),
      }));
    } catch (err) {
      // Red de seguridad para un fallo del propio SDK. Los cortes de red NO
      // llegan hasta aquí: el SDK los atrapa y los devuelve como `error` (ver
      // más abajo).
      logger.error({ to, subject, err: { message: err.message, code: err.code } }, "sendEmail: el SDK de Resend falló de forma inesperada");
      return { sent: false, reason: "resend_sdk_error" };
    }

    // El SDK NO lanza cuando la API rechaza: resuelve con { data: null, error }.
    // Sin este chequeo un 403 se registraría como envío exitoso.
    if (error) {
      const statusCode = error.statusCode ?? null;
      const nombre = error.name || "";

      // 403 = sandbox; 422 invalid_from_address = mismo problema de fondo
      // (dominio sin verificar) pero visto desde el remitente.
      // Se mira tambien el texto porque `statusCode` no es parte del tipo que
      // documenta el SDK (solo {message, name}): llega de rebote al parsear el
      // cuerpo, y si la respuesta viniera sin el se perderia justo este aviso,
      // que es el unico que dice como arreglarlo.
      const suenaASandbox = /resend\.com\/domains|verify a domain|testing emails/i.test(error.message || "");
      if (statusCode === 403 || nombre === "invalid_from_address" || suenaASandbox) {
        explicarSandbox({ to, from, mensaje: error.message, statusCode });
        return { sent: false, reason: "resend_sandbox" };
      }

      // Resend limita a 2 envíos por segundo y las notificaciones de cambio de
      // estado salen en ráfaga; un reintento corto evita perder esos correos.
      if (statusCode === 429 || nombre === "rate_limit_exceeded") {
        if (intento === 1) {
          await esperar(1000);
          continue;
        }
        logger.error({ to, subject }, "sendEmail: Resend rechazó por límite de envíos aun después del reintento");
        return { sent: false, reason: "rate_limited" };
      }

      // Cuando el servidor no logra salir a internet, el SDK NO lanza: atrapa
      // el fallo de fetch y lo devuelve como "application_error" sin
      // statusCode. Sin esta rama eso se registraba como "Resend rechazó el
      // envío", que manda a revisar la cuenta de Resend cuando el problema está
      // en la salida del droplet (DNS, firewall, 443 caído).
      if (statusCode === null && nombre === "application_error") {
        logger.error(
          { to, subject, resend: { name: nombre, message: error.message } },
          "sendEmail: no se pudo contactar api.resend.com por HTTPS. Es un problema de salida a internet/DNS del servidor, no de la cuenta de Resend.",
        );
        return { sent: false, reason: "resend_network_error" };
      }

      logger.error(
        { to, subject, from, statusCode, resend: { name: nombre, message: error.message } },
        "sendEmail: Resend rechazó el envío",
      );
      return { sent: false, reason: "resend_error" };
    }

    logger.info({ to, subject, messageId: data?.id }, "email enviado por Resend");
    return { sent: true, messageId: data?.id };
  }

  return { sent: false, reason: "rate_limited" };
};

const enviarPorSmtp = async ({ to, subject, text, html }) => {
  try {
    const info = await smtpTransporter.sendMail({ from: env.EMAIL_FROM, to, subject, text, html });
    logger.info({ to, subject, messageId: info.messageId }, "email enviado por SMTP");
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    // ETIMEDOUT / ENETUNREACH / ESOCKET aquí casi siempre significan que el
    // puerto SMTP de salida está bloqueado, no que las credenciales estén mal.
    const bloqueoDePuerto = ["ETIMEDOUT", "ESOCKET", "ENETUNREACH", "ECONNREFUSED"].includes(error.code);
    logger.error(
      { to, subject, err: { message: error.message, code: error.code } },
      bloqueoDePuerto && env.isProd
        ? "sendEmail: SMTP no conecta. En el droplet de DigitalOcean los puertos 25/465/587 están bloqueados de salida; hay que configurar RESEND_API_KEY para que el correo salga por HTTPS."
        : "sendEmail: SMTP falló",
    );
    return { sent: false, reason: "smtp_error" };
  }
};

/**
 * Envía un correo. Nunca lanza al caller: los siete puntos de llamada (auth,
 * pedidos, pagos) dependen de que un fallo de correo no rompa el registro ni el
 * checkout, así que los problemas se registran y se devuelven en `reason`.
 */
export const sendEmail = async ({ to, subject, text, html }) => {
  if (!to) {
    logger.warn("sendEmail llamado sin destinatario");
    return { sent: false, reason: "no_recipient" };
  }

  if (via === "resend") return enviarPorResend({ to, subject, text, html });
  if (via === "smtp") return enviarPorSmtp({ to, subject, text, html });

  logger.warn({ to, subject }, "sendEmail: transporte no configurado, email omitido");
  return { sent: false, reason: "no_transport" };
};
