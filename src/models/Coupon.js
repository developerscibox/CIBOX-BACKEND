import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    allowed_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    discount_type: {
      type: String,
      enum: ["percent", "fixed"],
      required: true,
    },
    discount_value: {
      type: Number,
      required: true,
      min: 0,
    },
    min_subtotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    max_discount: {
      type: Number,
      default: null,
      min: 0,
    },
    starts_at: {
      type: Date,
      default: null,
    },
    expires_at: {
      type: Date,
      default: null,
    },
    max_uses: {
      type: Number,
      default: null,
      min: 1,
    },
    max_uses_per_user: {
      type: Number,
      default: 1,
      min: 1,
    },
    used_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    first_purchase_only: {
      type: Boolean,
      default: false,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

couponSchema.index({ is_active: 1, expires_at: 1 });

export const Coupon =
  mongoose.models.Coupon || mongoose.model("Coupon", couponSchema);
export default Coupon;
