import mongoose from "mongoose";

const customBoxItemSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    thumbnail: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    unit_price: { type: Number, required: true, min: 0 },
    original_unit_price: { type: Number, min: 0 },
    tier_label: { type: String, trim: true, default: null },
    discount_applied: { type: Boolean, default: false },
    discount_percent: { type: Number, default: 0, min: 0 },
    discount_amount_per_unit: { type: Number, default: 0, min: 0 },
    discount_source: {
      type: String,
      enum: ["pantry", "cibox_plus", null],
      default: null,
    },
    subtotal: { type: Number, required: true, min: 0 },
    original_subtotal: { type: Number, min: 0 },
  },
  { _id: false }
);

const customBoxSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    guest_id: { type: String, default: null },
    name: { type: String, default: null, trim: true },
    items: { type: [customBoxItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    shipping_estimate: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["draft", "ordered"],
      default: "draft",
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

customBoxSchema.index({ user_id: 1 });
customBoxSchema.index({ guest_id: 1 });
customBoxSchema.index({ status: 1 });

export const CustomBox =
  mongoose.models.CustomBox || mongoose.model("CustomBox", customBoxSchema);
export default CustomBox;
