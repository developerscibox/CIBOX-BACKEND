import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, default: null, trim: true },
    image_url: { type: String, default: null },
    parent_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    is_active: { type: Boolean, default: true },
    is_featured: { type: Boolean, default: false },
    sort_order: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ parent_id: 1, sort_order: 1 });
categorySchema.index({ is_active: 1 });

export const Category =
  mongoose.models.Category || mongoose.model("Category", categorySchema);
export default Category;
