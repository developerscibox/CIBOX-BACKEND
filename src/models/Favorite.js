import mongoose from "mongoose";

const favoriteSchema = new mongoose.Schema(
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
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

favoriteSchema.index({ user_id: 1, product_id: 1 }, { unique: true });
favoriteSchema.index({ user_id: 1, created_at: -1 });

export const Favorite =
  mongoose.models.Favorite || mongoose.model("Favorite", favoriteSchema);
export default Favorite;
