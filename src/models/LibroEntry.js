import mongoose from "mongoose";

// Asiento del libro de compra/venta (F3.2 — contabilidad). SCAFFOLD: la lógica
// tributaria/contable NO se asume; requiere validación de un contador (NEEDS-INPUT).
// Solo deja la forma de datos para cuando se construya el módulo contable.
const libroEntrySchema = new mongoose.Schema(
  {
    tipo: { type: String, enum: ["compra", "venta"], required: true, index: true },
    periodo: { type: String, required: true, index: true }, // YYYY-MM
    fecha: { type: String, default: "" },
    documento: { type: String, default: "" }, // folio
    rut: { type: String, default: "" },
    neto: { type: Number, default: 0 },
    iva: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    revisado_contador: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

export const LibroEntry =
  mongoose.models.LibroEntry || mongoose.model("LibroEntry", libroEntrySchema);
export default LibroEntry;
