import mongoose from "mongoose";

/**
 * Módulo de atención (mostrador/caja). Lista configurable por admin/gerente.
 * Al "Llamar al siguiente" el vendedor indica su módulo y el turno queda
 * asignado a él, para que la pantalla muestre a qué módulo debe ir el cliente.
 */
const moduleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

moduleSchema.index({ active: 1, order: 1 });

export const Module = mongoose.models.Module || mongoose.model("Module", moduleSchema);
export default Module;
