import mongoose from "mongoose";

/**
 * MENSAJE DEL FORMULARIO "CONTÁCTANOS".
 *
 * POR QUÉ SE GUARDA Y NO SOLO SE MANDA POR CORREO
 * Antes el formulario armaba un `mailto:` y abría el programa de correo de la
 * persona. En un teléfono suele funcionar; en un navegador de escritorio sin
 * cliente configurado —que es el caso normal— no pasaba nada y el mensaje se
 * perdía sin que nadie se enterara, ni el cliente ni Cibox. Tampoco quedaba
 * registro: si el correo rebotaba, el mensaje desaparecía.
 *
 * Ahora el mensaje se guarda ACÁ PRIMERO y recién después se intenta avisar por
 * correo. Si el correo falla, el mensaje sigue estando: se puede leer de la base
 * y responder. El envío es el aviso, no el almacén.
 *
 * El `estado` queda listo para la bandeja del panel cuando se construya.
 */
const contactMessageSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
    telefono: { type: String, default: null, trim: true, maxlength: 40 },
    asunto: { type: String, default: "", trim: true, maxlength: 160 },
    mensaje: { type: String, required: true, trim: true, maxlength: 5000 },

    estado: {
      type: String,
      enum: ["nuevo", "en_curso", "resuelto", "descartado"],
      default: "nuevo",
      index: true,
    },

    // Si la persona tenía sesión abierta, queda el vínculo. No es obligatorio:
    // el formulario es público y la mayoría escribe sin cuenta.
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // Para responder dudas del tipo "¿les llegó mi mensaje?" sin adivinar.
    email_enviado: { type: Boolean, default: false },

    // Rastro mínimo para moderar abuso. No se publica nunca.
    origen_ip: { type: String, default: null },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

contactMessageSchema.index({ created_at: -1 });

/**
 * Folio de 6 caracteres para que la persona pueda citar su mensaje. Misma
 * fórmula que el folio de los pedidos (`folioDe` en utils/emailTemplates.js):
 * el identificador completo de Mongo son 24 caracteres ilegibles que nadie
 * dicta por teléfono.
 */
contactMessageSchema.virtual("folio").get(function () {
  return String(this._id || "").slice(-6).toUpperCase();
});

contactMessageSchema.set("toJSON", { virtuals: true });
contactMessageSchema.set("toObject", { virtuals: true });

export default mongoose.models.ContactMessage ||
  mongoose.model("ContactMessage", contactMessageSchema);
