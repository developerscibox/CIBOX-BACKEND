import mongoose from "mongoose";

const REFUND_REASONS = [
  "customer_request",
  "damaged",
  "wrong_item",
  "not_received",
  "other",
];

const REFUND_STATUSES = ["pending", "approved", "rejected", "processed", "failed"];

const refundItemSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: { type: Number, required: true, min: 1 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const refundSchema = new mongoose.Schema(
  {
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
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
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
    },

    amount: { type: Number, required: true, min: 0 },
    reason: {
      type: String,
      enum: REFUND_REASONS,
      required: true,
    },
    description: { type: String, default: "", trim: true, maxlength: 2000 },

    items: {
      type: [refundItemSchema],
      default: [],
    },

    type: {
      type: String,
      enum: ["full", "partial"],
      required: true,
    },

    status: {
      type: String,
      enum: REFUND_STATUSES,
      default: "pending",
      index: true,
    },

    transbank_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    processed_at: { type: Date, default: null },
    processed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    created_by: {
      type: String,
      default: "user",
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

refundSchema.index({ order_id: 1 });
refundSchema.index({ status: 1, created_at: -1 });
refundSchema.index({ user_id: 1, created_at: -1 });

export const REFUND_REASONS_LIST = REFUND_REASONS;
export const REFUND_STATUSES_LIST = REFUND_STATUSES;

export const Refund = mongoose.models.Refund || mongoose.model("Refund", refundSchema);
export default Refund;
