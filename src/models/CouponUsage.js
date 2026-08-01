import mongoose from "mongoose";

const couponUsageSchema = new mongoose.Schema(
  {
    coupon_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    guest_id: {
      type: String,
      default: null,
    },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    discount_amount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Clave de uso ÚNICO por usuario: se setea al user_id SOLO cuando el cupón es
    // de un uso por persona (max_uses_per_user=1). El índice único parcial de abajo
    // cierra atómicamente la carrera de reuso (dos checkouts concurrentes del mismo
    // usuario ya no pueden aplicar dos veces un cupón de uso único). Null (multiuso)
    // no entra al índice.
    single_use_key: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

couponUsageSchema.index({ coupon_id: 1, user_id: 1 });
couponUsageSchema.index({ coupon_id: 1, order_id: 1 }, { unique: true });
couponUsageSchema.index(
  { coupon_id: 1, single_use_key: 1 },
  { unique: true, partialFilterExpression: { single_use_key: { $type: "objectId" } } },
);
couponUsageSchema.index({ order_id: 1 });

export const CouponUsage =
  mongoose.models.CouponUsage ||
  mongoose.model("CouponUsage", couponUsageSchema);
export default CouponUsage;
