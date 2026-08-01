import mongoose from "mongoose";

export const AUTORIZACION_TIPOS = ["anulacion", "precio"];
export const AUTORIZACION_ESTADOS = ["pendiente", "aprobada", "rechazada"];

/**
 * Solicitud de autorización sensible de caja (anular boleta / cambiar precio).
 * REGISTRO INMUTABLE: nunca se borra ni se edita el detalle — solo se resuelve
 * (aprobada/rechazada). Los campos de la solicitud son `immutable` a nivel de
 * schema para que ni siquiera un save posterior pueda alterarlos.
 */
const autorizacionSchema = new mongoose.Schema(
  {
    tipo: {
      type: String,
      enum: AUTORIZACION_TIPOS,
      required: true,
      immutable: true,
    },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
      immutable: true,
    },
    // Últimos 6 del _id del pedido, en mayúsculas (mismo folio que usa el panel).
    folio: { type: String, required: true, immutable: true },
    // Total del pedido al momento de solicitar (snapshot).
    monto: { type: Number, required: true, min: 0, immutable: true },
    // Motivo de la anulación o propuesta de precio. NUNCA se edita.
    detalle: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
      immutable: true,
    },
    // Solo tipo="precio": los cambios de precio POR ÍTEM propuestos por la
    // cajera (snapshot del precio vigente al solicitar). Al APROBARSE se
    // aplican al pedido (si sigue por pagar). Inmutable como el resto.
    cambios: {
      type: [
        {
          _id: false,
          product_id: { type: mongoose.Schema.Types.ObjectId, required: true },
          name: { type: String, required: true },
          cantidad: { type: Number, required: true, min: 1 },
          precio_actual: { type: Number, required: true, min: 0 },
          precio_propuesto: { type: Number, required: true, min: 1 },
        },
      ],
      default: [],
      immutable: true,
    },
    solicitante: {
      user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
        immutable: true,
      },
      label: { type: String, default: null, immutable: true },
      role: { type: String, default: null, immutable: true },
    },

    estado: {
      type: String,
      enum: AUTORIZACION_ESTADOS,
      default: "pendiente",
    },
    resuelto_por: {
      user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      label: { type: String, default: null },
    },
    resuelto_en: { type: Date, default: null },
    nota_resolucion: { type: String, default: null, trim: true, maxlength: 300 },

    // Mensaje publicado en el grupo de Telegram (para editarlo al resolver).
    telegram_chat_id: { type: String, default: null },
    telegram_message_id: { type: Number, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

// Bandeja del jefe: pendientes primero, ordenadas por fecha.
autorizacionSchema.index({ estado: 1, created_at: -1 });

export const Autorizacion =
  mongoose.models.Autorizacion || mongoose.model("Autorizacion", autorizacionSchema);
export default Autorizacion;
