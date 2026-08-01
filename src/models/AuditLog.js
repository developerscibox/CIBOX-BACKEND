import mongoose from "mongoose";

// Bitácora de acciones sensibles fuera del flujo de pedido/inventario (que ya
// quedan trazados en Order.status_history y StockMovement). Aquí: cambios de
// precio/producto, de rol y de estado de usuarios. Append-only.
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },          // ej "producto.editar", "usuario.rol"
    actor: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      role: { type: String, default: null },
      label: { type: String, default: null },          // nombre/correo de quién
    },
    target: { type: String, default: null },           // sobre qué (nombre legible)
    detail: { type: String, default: null },           // qué cambió
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
auditLogSchema.index({ at: -1 });

export default mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
