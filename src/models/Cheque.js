import mongoose from "mongoose";

// Cheque recibido de un cliente (F2.5). Para el radar de cheques por vencer.
const chequeSchema = new mongoose.Schema(
  {
    cliente: { type: String, required: true, trim: true, index: true },
    numero: { type: String, required: true, trim: true },
    banco: { type: String, default: "", trim: true },
    monto: { type: Number, required: true, min: 0 },
    fecha_vencimiento: { type: String, required: true }, // YYYY-MM-DD
    estado: {
      type: String,
      enum: ["en_cartera", "depositado", "pagado", "protestado"],
      default: "en_cartera",
      index: true,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

export const Cheque = mongoose.models.Cheque || mongoose.model("Cheque", chequeSchema);
export default Cheque;
