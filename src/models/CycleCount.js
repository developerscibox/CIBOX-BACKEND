import mongoose from "mongoose";

/**
 * CycleCount: sesión de conteo físico (cycle count) de inventario.
 *
 * Principio: el conteo físico es AUTORITATIVO. Al cerrar, `stock := contado`.
 * El `theoretical_qty` capturado al iniciar es solo informativo (mostrar la
 * diferencia mientras se cuenta); el ajuste real se calcula contra el stock
 * ACTUAL al cerrar (no el snapshot), para que el conteo mande aunque haya
 * habido movimiento durante el conteo.
 *
 * El cierre reusa adjustStock (atómico, kardex, consumo FEFO de lotes en
 * negativos): un adjustStock por línea contada con diferencia, best-effort.
 */
const cycleCountLineSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    product_name: { type: String, default: "", trim: true }, // snapshot
    sku: { type: String, default: "", trim: true },
    barcode: { type: String, default: "", trim: true },
    theoretical_qty: { type: Number, default: 0 }, // snapshot de Product.stock al iniciar
    counted_qty: { type: Number, default: null, min: 0 }, // ingresado (null = sin contar)
    counted: { type: Boolean, default: false }, // true cuando se ingresó cantidad
    // Stock que el sistema tenía en el INSTANTE en que se contó esta línea, y
    // cuándo fue. Con esto el cierre puede aplicar la discrepancia detectada
    // (contado − stock de ese momento) en vez de forzar el stock al valor
    // contado, que revertía todas las ventas ocurridas mientras se contaba.
    stock_at_count: { type: Number, default: null },
    counted_at: { type: Date, default: null },
  },
  { _id: false },
);

const cycleCountSchema = new mongoose.Schema(
  {
    scope: {
      type: { type: String, enum: ["category", "all"], required: true },
      value: { type: String, default: "", trim: true }, // categoría; "" para all
      label: { type: String, default: "", trim: true }, // texto legible para la UI
    },
    status: {
      type: String,
      enum: ["open", "closed", "cancelled"],
      default: "open",
      index: true,
    },
    lines: { type: [cycleCountLineSchema], default: [] },
    created_by: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      role: { type: String, default: null },
      label: { type: String, default: "sistema", trim: true },
    },
    closed_by: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      role: { type: String, default: null },
      label: { type: String, default: null, trim: true },
    },
    // Resumen del cierre (null mientras open/cancelled).
    applied: {
      type: new mongoose.Schema(
        {
          lines_adjusted: { type: Number, default: 0 },
          units_delta: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    closed_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

// Listado: abiertos primero, recientes después (status + fecha desc).
cycleCountSchema.index({ status: 1, created_at: -1 });

export const CycleCount =
  mongoose.models.CycleCount || mongoose.model("CycleCount", cycleCountSchema);
export default CycleCount;
