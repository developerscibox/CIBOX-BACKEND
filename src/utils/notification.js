import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { logger } from "./logger.js";

/**
 * Crea una notificación. Skip silencioso si user_id es nulo (e.g. invitado).
 * No lanza errores hacia arriba: el flujo principal nunca debe fallar por una notificación.
 */
export const createNotification = async ({
  user_id,
  type = "system",
  title,
  body,
  data = {},
}) => {
  if (!user_id) {
    logger.debug({ type, title }, "notification.skip:no_user");
    return null;
  }

  if (!title || !body) {
    logger.warn({ user_id, type }, "notification.skip:missing_fields");
    return null;
  }

  try {
    const notification = await Notification.create({
      user_id,
      type,
      title,
      body,
      data,
    });
    return notification;
  } catch (err) {
    logger.error(
      { err: { message: err.message }, user_id, type },
      "notification.create_failed"
    );
    return null;
  }
};

/**
 * Crea notificaciones en bulk para todos los usuarios de un rol.
 */
export const createNotificationsForRole = async ({
  role,
  type = "system",
  title,
  body,
  data = {},
}) => {
  if (!role || !title || !body) {
    logger.warn({ role, type }, "notification.bulk.skip:missing_fields");
    return [];
  }

  try {
    const users = await User.find({ role, is_active: true })
      .select("_id")
      .lean();

    if (!users.length) return [];

    const payload = users.map((u) => ({
      user_id: u._id,
      type,
      title,
      body,
      data,
    }));

    const inserted = await Notification.insertMany(payload, { ordered: false });
    return inserted;
  } catch (err) {
    logger.error(
      { err: { message: err.message }, role, type },
      "notification.bulk.failed"
    );
    return [];
  }
};
