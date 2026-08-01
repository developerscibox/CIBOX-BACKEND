import mongoose from "mongoose";

export const NOTIFICATION_TYPES = [
  "order_created",
  "order_status_changed",
  "order_paid",
  "order_shipped",
  "order_delivered",
  "review_created",
  "review_approved",
  "vendor_approved",
  "vendor_rejected",
  "vendor_new_order",
  "vendor_new_review",
  "vendor_product_deactivated",
  "coupon_created",
  "favorite_price_drop",
  "admin_new_order",
  "admin_new_review",
  "admin_new_vendor_request",
  "admin_order_cancelled",
  "system",
];

const notificationSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      default: "system",
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    is_read: { type: Boolean, default: false },
    read_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

notificationSchema.index({ user_id: 1, is_read: 1, created_at: -1 });
notificationSchema.index({ user_id: 1, created_at: -1 });

export const Notification =
  mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
export default Notification;
