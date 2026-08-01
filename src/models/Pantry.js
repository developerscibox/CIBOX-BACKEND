import mongoose from "mongoose";

const pantryItemSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    last_purchased_at: { type: Date, default: null },
    auto_reorder: { type: Boolean, default: false },
    frequency_days: { type: Number, default: 30, min: 1 },
  },
  { _id: false }
);

const pantrySchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    items: { type: [pantryItemSchema], default: [] },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

pantrySchema.index({ user_id: 1 }, { unique: true });

export const Pantry =
  mongoose.models.Pantry || mongoose.model("Pantry", pantrySchema);
export default Pantry;
