import { asyncHandler } from "../middlewares/errorHandler.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const savePushToken = asyncHandler(async (req, res) => {
  const { push_token } = req.body;

  // Validación básica del formato de Expo push token
  if (push_token && !String(push_token).startsWith("ExponentPushToken[")) {
    return res.status(400).json({ success: false, message: "Token de push inválido" });
  }

  await User.updateOne(
    { _id: req.user.id },
    { $set: { push_token: push_token || null, push_token_updated_at: new Date() } },
  );

  logger.debug({ userId: req.user.id }, "push_token guardado");
  return res.status(200).json({ success: true });
});

export const listMyNotifications = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = { user_id: userId };
  if (req.query.unread_only === "true") filter.is_read = false;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user_id: userId, is_read: false }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      items,
      unread_count: unreadCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
  });
});

export const getUnreadCount = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const count = await Notification.countDocuments({
    user_id: userId,
    is_read: false,
  });

  return res.status(200).json({
    success: true,
    data: { unread_count: count },
  });
});

export const markAsRead = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user_id: userId },
    { $set: { is_read: true, read_at: new Date() } },
    { new: true }
  ).lean();

  if (!notification) throw new NotFoundError("Notificación no encontrada");

  return res.status(200).json({
    success: true,
    data: { notification },
    message: "Notificación marcada como leída",
  });
});

export const markAllAsRead = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const result = await Notification.updateMany(
    { user_id: userId, is_read: false },
    { $set: { is_read: true, read_at: new Date() } }
  );

  logger.info(
    { user_id: userId, count: result.modifiedCount },
    "notification.mark_all_read"
  );

  return res.status(200).json({
    success: true,
    data: { updated: result.modifiedCount || 0 },
    message: "Todas las notificaciones fueron marcadas como leídas",
  });
});

export const deleteNotification = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const result = await Notification.findOneAndDelete({
    _id: req.params.id,
    user_id: userId,
  }).lean();

  if (!result) throw new NotFoundError("Notificación no encontrada");

  return res.status(200).json({
    success: true,
    message: "Notificación eliminada",
  });
});
