import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: "", trim: true, maxlength: 120 },
    comment: { type: String, default: "", trim: true, maxlength: 4000 },
    images: { type: [String], default: [] },
    is_verified_purchase: { type: Boolean, default: false },
    is_approved: { type: Boolean, default: false },
    moderated_at: { type: Date, default: null },
    moderated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rejection_reason: { type: String, default: null, trim: true },
    helpful_count: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

reviewSchema.index({ product_id: 1, is_approved: 1, created_at: -1 });
reviewSchema.index({ user_id: 1 });
reviewSchema.index({ product_id: 1, user_id: 1 }, { unique: true });

export const Review =
  mongoose.models.Review || mongoose.model("Review", reviewSchema);
export default Review;
