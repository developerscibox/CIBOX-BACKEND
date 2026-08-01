import mongoose from "mongoose";

const TAX_DOC_TYPES = ["boleta", "factura"];
const TAX_DOC_STATUSES = ["pending", "accepted", "rejected", "voided"];

const taxDocumentSchema = new mongoose.Schema(
  {
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: TAX_DOC_TYPES,
      required: true,
    },
    folio: { type: String, default: null, index: true },
    rut_receptor: { type: String, default: "", trim: true },
    razon_social: { type: String, default: "", trim: true, maxlength: 200 },
    total: { type: Number, required: true, min: 0 },
    neto: { type: Number, default: 0, min: 0 },
    iva: { type: Number, default: 0, min: 0 },
    xml_url: { type: String, default: null },
    pdf_url: { type: String, default: null },
    sii_track_id: { type: String, default: null },
    status: {
      type: String,
      enum: TAX_DOC_STATUSES,
      default: "pending",
      index: true,
    },
    stub: { type: Boolean, default: false },
    emitted_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// Un único documento tributario ACTIVO (pending/accepted) por orden y tipo: cierra
// la carrera de doble emisión (se puede re-emitir tras anular/rechazar).
taxDocumentSchema.index(
  { order_id: 1, type: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["pending", "accepted"] } } },
);
taxDocumentSchema.index({ status: 1, created_at: -1 });

export const TAX_DOC_TYPES_LIST = TAX_DOC_TYPES;
export const TAX_DOC_STATUSES_LIST = TAX_DOC_STATUSES;

export const TaxDocument =
  mongoose.models.TaxDocument || mongoose.model("TaxDocument", taxDocumentSchema);
export default TaxDocument;
