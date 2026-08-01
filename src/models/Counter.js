import mongoose from "mongoose";

/**
 * Contador atómico genérico (correlativos por clave). Se usa para numerar los
 * turnos del día sin condiciones de carrera: findByIdAndUpdate($inc) es atómico.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export const Counter = mongoose.models.Counter || mongoose.model("Counter", counterSchema);
export default Counter;
