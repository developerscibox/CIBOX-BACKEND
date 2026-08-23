import mongoose from "mongoose";

const cartBoxItemSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: { type: Number, default: 1, min: 1 },
    name: { type: String, default: "", trim: true },
    thumbnail: { type: String, default: "" },
    unit_price: { type: Number, default: 0, min: 0 },
    brand: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const cartItemSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    thumbnail: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    unit_price: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    tier_label: { type: String, default: null, trim: true },
    // Texto del precio por unidad de medida (decreto 38/2024) calculado sobre el
    // precio realmente cobrado. Se congela con el ítem, igual que unit_price.
    ppum_label: { type: String, default: "", trim: true },
    // Unidades por caja (paso de cantidad). Cibox vende solo por caja.
    box_qty: { type: Number, default: 1, min: 1 },
    product_type: {
      type: String,
      enum: ["individual", "box"],
      default: "individual",
    },
    box_items: {
      type: [cartBoxItemSchema],
      default: [],
    },
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    guest_id: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "converted", "abandoned"],
      default: "active",
    },
    items: {
      type: [cartItemSchema],
      default: [],
    },
    // Marca de origen: el carrito lo armó "Recomprar todo" desde Mi Despensa y
    // por lo tanto lleva el descuento de despensa.
    //
    // POR QUÉ EXISTE: sin esta marca, el checkout mostraba el carrito con el
    // descuento aplicado pero al crear la orden se recalculaba todo a precio de
    // lista (rebuildItemsFromCart no sabía de dónde venía), y el cliente
    // terminaba pagando ~11% más de lo que había aceptado en pantalla.
    from_pantry: {
      type: Boolean,
      default: false,
    },
    total: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

cartSchema.index({ user_id: 1 });
cartSchema.index({ guest_id: 1 });
cartSchema.index({ status: 1, updated_at: 1 });
cartSchema.index({ user_id: 1, status: 1 });
cartSchema.index({ guest_id: 1, status: 1 });

export const Cart = mongoose.models.Cart || mongoose.model("Cart", cartSchema);
export default Cart;
