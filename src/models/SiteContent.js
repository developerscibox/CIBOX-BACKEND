import mongoose from "mongoose";

/**
 * Contenido editable del sitio (CMS liviano). Un documento singleton por
 * "key" (hoy solo "home"): los slots son un objeto libre (Mixed) cuyo shape
 * lo define y valida el controller (SPECS + zod). minimize:false para que
 * los objetos vacíos dentro de slots se persistan tal cual.
 */
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    slots: { type: mongoose.Schema.Types.Mixed, default: null },
    updated_by: {
      user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      label: { type: String, default: null },
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    minimize: false,
  }
);

siteContentSchema.index({ key: 1 }, { unique: true });

export const SiteContent =
  mongoose.models.SiteContent || mongoose.model("SiteContent", siteContentSchema);
export default SiteContent;
