import { User } from "../models/User.js";
import { logger } from "../utils/logger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Envía una push notification a un Expo Push Token específico.
 * No lanza errores — nunca debe bloquear el flujo principal.
 */
export const sendPushNotification = async ({
  pushToken,
  title,
  body,
  data = {},
  sound = "default",
  badge = 1,
}) => {
  if (!pushToken || !String(pushToken).startsWith("ExponentPushToken[")) {
    return null;
  }

  const message = { to: pushToken, title, body, data, sound, badge };

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    const result = await res.json();

    if (result?.data?.status === "error") {
      logger.warn(
        { pushToken, details: result.data.details },
        "push: token inválido o error de Expo",
      );
    } else {
      logger.debug({ title, pushToken: pushToken.slice(0, 30) }, "push enviada");
    }

    return result;
  } catch (err) {
    logger.warn({ err: err.message }, "push: fallo al contactar Expo API");
    return null;
  }
};

/**
 * Busca el push_token de un usuario y le envía una notificación.
 * Seguro: si el usuario no tiene token, retorna null silenciosamente.
 */
export const sendPushToUser = async ({ userId, title, body, data = {} }) => {
  if (!userId) return null;

  try {
    const user = await User.findById(userId).select("push_token").lean();
    if (!user?.push_token) return null;

    return sendPushNotification({ pushToken: user.push_token, title, body, data });
  } catch (err) {
    logger.warn({ err: err.message, userId }, "push: error buscando usuario");
    return null;
  }
};
