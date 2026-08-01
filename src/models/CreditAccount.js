import mongoose from "mongoose";

// Cuenta corriente / crédito de un cliente (F2.5). Scaffold: las reglas de cupo
// y plazos reales son NEEDS-INPUT (B6). El libro contable del sistema anterior se
// reemplaza en la migración; acá se expone cupo/saldo para el vendedor en terreno.
const creditAccountSchema = new mongoose.Schema(
  {
    cliente: { type: String, required: true, trim: true, index: true },
    rut: { type: String, default: "", trim: true },
    cupo: { type: Number, default: 0, min: 0 }, // límite de crédito (B6)
    saldo: { type: Number, default: 0 }, // deuda vigente
    dias_credito: { type: Number, default: 30, min: 0 }, // plazo (B6)
    activo: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

creditAccountSchema.virtual("disponible").get(function () {
  return Math.max(0, (Number(this.cupo) || 0) - (Number(this.saldo) || 0));
});

export const CreditAccount =
  mongoose.models.CreditAccount || mongoose.model("CreditAccount", creditAccountSchema);
export default CreditAccount;
