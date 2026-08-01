import mongoose from "mongoose";

export const PRICE_APPROVAL_ESTADOS = [
  "pendiente",
  "aprobada",
  "rechazada",
  "cancelada",
];

const tierSchema = new mongoose.Schema(
  {
    _id: false,
    min_qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    label: { type: String, default: "" },
  },
  { _id: false },
);

/**
 * Solicitud de CAMBIO DE PRECIO del catálogo que requiere aprobación por
 * Telegram. REGISTRO INMUTABLE: los datos de la solicitud (solicitante, motivo,
 * cambios) nunca se editan — solo se resuelve el `estado`. Es la evidencia
 * permanente de quién pidió el cambio y quién lo aprobó/denegó.
 */
const priceApprovalSchema = new mongoose.Schema(
  {
    // Snapshot inmutable de cada producto a cambiar. `tiers_actuales` es el precio
    // vigente al solicitar; `tiers_propuestos` es lo que se aplica si se aprueba.
    cambios: {
      type: [
        {
          _id: false,
          product_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
          },
          nombre: { type: String, required: true },
          precio_actual: { type: Number, required: true, min: 0 }, // venta vigente (display)
          precio_propuesto: { type: Number, required: true, min: 0 }, // venta propuesta (display)
          tiers_actuales: { type: [tierSchema], default: [] },
          tiers_propuestos: { type: [tierSchema], required: true },
        },
      ],
      default: [],
      immutable: true,
    },
    motivo: { type: String, default: null, trim: true, maxlength: 300, immutable: true },
    solicitante: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
      nombre: { type: String, default: null, immutable: true },
      role: { type: String, default: null, immutable: true },
    },

    estado: { type: String, enum: PRICE_APPROVAL_ESTADOS, default: "pendiente" },

    // Mensaje publicado en el grupo (para editarlo al resolver/cancelar).
    telegram_chat_id: { type: String, default: null },
    telegram_message_id: { type: Number, default: null },

    // Quién tocó el botón en Telegram (aprobó/denegó).
    resuelto_por: {
      telegram_id: { type: String, default: null },
      nombre: { type: String, default: null },
    },
    resuelto_en: { type: Date, default: null },

    // Quién canceló (el solicitante o un admin), si aplica.
    cancelada_por: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      nombre: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

// Bandeja: pendientes primero.
priceApprovalSchema.index({ estado: 1, created_at: -1 });
// Para chequear rápido si un producto ya tiene solicitud pendiente.
priceApprovalSchema.index({ "cambios.product_id": 1, estado: 1 });

export const PriceApproval =
  mongoose.models.PriceApproval || mongoose.model("PriceApproval", priceApprovalSchema);
export default PriceApproval;
