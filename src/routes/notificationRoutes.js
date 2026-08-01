import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import {
  listNotificationsSchema,
  notificationParamsSchema,
} from "../validators/notificationValidators.js";
import {
  savePushToken,
  listMyNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
} from "../controllers/notificationController.js";

const router = Router();

router.use(protect);

router.put("/push-token", savePushToken);
router.get("/", validate({ query: listNotificationsSchema }), listMyNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllAsRead);
router.patch(
  "/:id/read",
  validate({ params: notificationParamsSchema }),
  markAsRead
);
router.delete(
  "/:id",
  validate({ params: notificationParamsSchema }),
  deleteNotification
);

export default router;
