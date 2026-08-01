import mongoose from "mongoose";

// Sesión de caja (turno de la cajera): apertura con fondo inicial → cobros →
// cierre con efectivo contado y diferencia. Permite el cuadre formal del día.
const cajaSessionSchema = new mongoose.Schema(
  {
    cajera_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cajera_label: { type: String, default: "" },
    monto_inicial: { type: Number, default: 0, min: 0 },
    // Se completan al cerrar:
    ventas_efectivo: { type: Number, default: 0 }, // efectivo cobrado durante la sesión
    monto_esperado: { type: Number, default: 0 },  // monto_inicial + ventas_efectivo
    monto_contado: { type: Number, default: null },
    diferencia: { type: Number, default: 0 },
    estado: { type: String, enum: ["abierta", "cerrada"], default: "abierta", index: true },
    t_cierre: { type: Date, default: null },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }, // created_at = apertura
);

cajaSessionSchema.index({ cajera_id: 1, estado: 1 });
// Una sola sesión ABIERTA por cajera: evita dos cajas abiertas en paralelo (cuadre Z).
cajaSessionSchema.index(
  { cajera_id: 1 },
  { unique: true, partialFilterExpression: { estado: "abierta" } },
);

export default mongoose.models.CajaSession || mongoose.model("CajaSession", cajaSessionSchema);
