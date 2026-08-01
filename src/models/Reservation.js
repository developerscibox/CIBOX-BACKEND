import mongoose from "mongoose";

/**
 * Reserva temporal de stock por línea de carrito.
 *
 * Cada documento representa la retención de `quantity` unidades de un producto
 * para un carrito concreto. Mientras la reserva está `active` y no ha vencido,
 * esas unidades cuentan en `Product.reserved` y reducen el disponible.
 *
 * Estados:
 * - active:    retención vigente (cuenta en Product.reserved).
 * - released:  liberada (por quitar del carrito, expiración o limpieza).
 * - confirmed: convertida en venta real (la orden descontó el stock físico).
 *
 * El stock físico (Product.stock) NUNCA se toca aquí: solo Product.reserved.
 */
const reservationSchema = new mongoose.Schema(
  {
    cart_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cart",
      required: true,
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    guest_id: {
      type: String,
      default: null,
    },

    // Total de unidades reservadas para esta línea (ya normalizado por caja).
    quantity: { type: Number, required: true, min: 1 },
    // Unidades por caja al momento de reservar (auditoría / display).
    box_qty: { type: Number, default: 1, min: 1 },

    status: {
      type: String,
      enum: ["active", "released", "confirmed"],
      default: "active",
    },

    // Vencimiento de la retención. Pasado este momento la reserva se considera
    // liberada (lazy release en lecturas + job de barrido decrementa reserved).
    expires_at: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// Suma de reservas activas por producto (reconciliación) y lookups.
reservationSchema.index({ product_id: 1, status: 1 });

// Una sola reserva activa por (carrito, producto): permite upsert idempotente.
// Parcial sobre status=active para no chocar con released/confirmed antiguas.
reservationSchema.index(
  { cart_id: 1, product_id: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
  }
);

// Barrido de vencidas por el job de liberación.
reservationSchema.index({ status: 1, expires_at: 1 });

reservationSchema.index({ user_id: 1 });
reservationSchema.index({ guest_id: 1 });

export const Reservation =
  mongoose.models.Reservation ||
  mongoose.model("Reservation", reservationSchema);
export default Reservation;
