import mongoose from "mongoose";
import { MOVEMENT_TYPES } from "../utils/constants.js";

/**
 * Kardex: registro inmutable de cada movimiento de inventario.
 * Es la fuente de verdad para auditar "qué pasó con el stock, cuándo y quién".
 *
 * Convención: quantity negativo = salida, positivo = entrada.
 * stock_after = stock del producto inmediatamente después del movimiento
 * (puede ser null si el flujo no lo capturó, p. ej. migraciones antiguas).
 */
const stockMovementSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    product_name: { type: String, default: "", trim: true },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    type: {
      type: String,
      enum: Object.values(MOVEMENT_TYPES),
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isInteger(v) && v !== 0,
        message: "quantity debe ser un entero distinto de 0",
      },
    },
    stock_after: { type: Number, default: null, min: 0 },
    reason: { type: String, default: null, trim: true, maxlength: 300 },
    by: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      role: { type: String, default: null },
      label: { type: String, default: "sistema", trim: true },
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

stockMovementSchema.index({ product_id: 1, created_at: -1 });
stockMovementSchema.index({ order_id: 1 });
stockMovementSchema.index({ type: 1, created_at: -1 });
stockMovementSchema.index({ created_at: -1 });

export const StockMovement =
  mongoose.models.StockMovement ||
  mongoose.model("StockMovement", stockMovementSchema);
export default StockMovement;
