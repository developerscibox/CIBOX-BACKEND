import mongoose from "mongoose";

// Deuda (documento por cobrar) de un cliente a crédito (F2.5). Alimenta el aging.
const deudaSchema = new mongoose.Schema(
  {
    cliente: { type: String, required: true, trim: true, index: true },
    // Vínculo a la entidad Cliente (aditivo; null = deuda legada sin ficha).
    cliente_id: { type: mongoose.Schema.Types.ObjectId, ref: "Cliente", default: null, index: true },
    // Orden que originó el documento (venta a crédito de la cajera).
    order_id: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    documento: { type: String, required: true, trim: true },
    fecha_emision: { type: String, default: "" },
    fecha_vencimiento: { type: String, required: true }, // YYYY-MM-DD
    // monto = SALDO pendiente (el aging lo lee directo). Los abonos lo reducen.
    monto: { type: Number, required: true, min: 0 },
    // Snapshot del monto antes del primer abono (aditivo; null = sin abonos).
    monto_original: { type: Number, default: null, min: 0 },
    // Historial de abonos (pagos parciales) — aditivo, no rompe docs existentes.
    abonos: {
      type: [
        new mongoose.Schema(
          {
            fecha: { type: Date, default: Date.now },
            monto: { type: Number, required: true, min: 0 },
            // Medio/referencia del pago ("transferencia (op 1234)") — aditivo.
            nota: { type: String, default: "", trim: true },
            by: {
              user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
              role: { type: String, default: null },
              label: { type: String, default: "", trim: true },
            },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    estado: {
      type: String,
      enum: ["pendiente", "pagada"],
      default: "pendiente",
      index: true,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

export const Deuda = mongoose.models.Deuda || mongoose.model("Deuda", deudaSchema);
export default Deuda;
