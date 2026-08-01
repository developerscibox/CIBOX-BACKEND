import mongoose from "mongoose";

/**
 * Batch (lote): ledger paralelo de lotes recibidos. CAPA ADITIVA — NO es la
 * fuente de verdad de disponibilidad (esa es Product.stock). Aporta:
 *  - multi-vencimiento por producto (FEFO por lote),
 *  - costo por lote (histórico de compras),
 *  - trazabilidad pedido→lote (Order.items.batches).
 *
 * El consumo de lotes (pick/merma) es best-effort: sum(qty_remaining) puede
 * divergir de Product.stock y es tolerable (stock es autoritativo).
 *
 * status: "open" mientras qty_remaining > 0; "depleted" cuando llega a 0.
 * Se sincroniza en cada save() vía hook pre-validate.
 */
const batchSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    product_name: { type: String, default: "", trim: true }, // snapshot
    lot_code: { type: String, default: "", trim: true }, // proveedor o R{YYMMDD}-{n}
    qty_received: { type: Number, required: true, min: 0 }, // unidades al recibir
    qty_remaining: { type: Number, required: true, min: 0 }, // unidades sin consumir
    unit_cost: { type: Number, default: 0, min: 0 }, // costo de compra de ESTE lote
    expiry_date: { type: Date, default: null },
    location: {
      sector: { type: String, default: "", trim: true },
      zone: { type: String, default: "", trim: true },
      rack: { type: String, default: "", trim: true },
      level: { type: String, default: "", trim: true },
      code: { type: String, default: "", trim: true },
    },
    supplier: { type: String, default: "", trim: true },
    doc_ref: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["open", "depleted"],
      default: "open",
      index: true,
    },
    received_at: { type: Date, default: Date.now },
    received_by: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      role: { type: String, default: null },
      label: { type: String, default: "sistema", trim: true },
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// status derivado de qty_remaining: depleted en 0, open si queda algo.
// Hook SÍNCRONO (sin next): este Mongoose no pasa `next` a los pre('validate')
// y llamarlo rompía toda recepción ("next is not a function").
batchSchema.pre("validate", function syncStatus() {
  this.status = Number(this.qty_remaining) <= 0 ? "depleted" : "open";
});

// FEFO por producto (consumo en pick/merma) y para la pantalla Lotes.
batchSchema.index({ product_id: 1, status: 1, expiry_date: 1 });
// FEFO global (despacho por vencimiento de todo el inventario).
batchSchema.index({ status: 1, expiry_date: 1 });
// Histórico de costos por producto.
batchSchema.index({ product_id: 1, received_at: -1 });

export const Batch = mongoose.models.Batch || mongoose.model("Batch", batchSchema);
export default Batch;
