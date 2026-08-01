import mongoose from "mongoose";

// Cliente de cuenta corriente (CxC). Todo cliente parte SIN crédito (contado);
// el crédito se habilita con línea + condición (días) + días de gracia.
// El RUT se guarda normalizado "12345678-9" (sin puntos, DV en mayúscula).
const clienteSchema = new mongoose.Schema(
  {
    razon_social: { type: String, required: true, trim: true },
    rut: { type: String, required: true, unique: true, trim: true },
    contacto: {
      nombre: { type: String, default: "", trim: true },
      telefono: { type: String, default: "", trim: true },
      email: { type: String, default: "", trim: true },
    },
    credito: {
      habilitado: { type: Boolean, default: false },
      linea: { type: Number, default: 0, min: 0 },
      condicion_dias: { type: Number, default: 30, min: 0 },
      dias_gracia: { type: Number, default: 7, min: 0 },
      bloqueado: { type: Boolean, default: false },
      bloqueo_motivo: { type: String, default: "", trim: true },
      bloqueado_en: { type: Date, default: null },
      bloqueado_por: {
        label: { type: String, default: "", trim: true },
      },
    },
    notas: { type: String, default: "", trim: true },
    activo: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

export const Cliente = mongoose.models.Cliente || mongoose.model("Cliente", clienteSchema);
export default Cliente;
