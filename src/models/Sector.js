import mongoose from "mongoose";

// Sector físico de la bodega (lácteos, abarrotes, etc.). El campo `orden` define
// la secuencia de recorrido del preparador y, por ende, el orden de impresión de
// la boleta y el ticket de picking. Configurable sin tocar código.
const sectorSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true, unique: true },
    orden: { type: Number, default: 0 },
    activo: { type: Boolean, default: true },
  },
  { timestamps: true },
);

sectorSchema.index({ orden: 1 });

export default mongoose.models.Sector || mongoose.model("Sector", sectorSchema);
