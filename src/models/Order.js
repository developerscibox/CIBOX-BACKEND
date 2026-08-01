import mongoose from "mongoose";
import { ORDER_STATUS, PAYMENT_STATUS } from "../utils/constants.js";

const orderBoxItemSchema = new mongoose.Schema(
  {
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, default: "", trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    unit_price: { type: Number, default: 0, min: 0 },
    subtotal: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const orderItemSchema = new mongoose.Schema(
  {
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    box_id: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 }, // total de UNIDADES (cajas × box_qty)
    cajas: { type: Number, default: null, min: 0 },     // nº de cajas pedidas
    box_qty: { type: Number, default: null, min: 0 },   // unidades por caja (snapshot)
    price: { type: Number, required: true, min: 0 },
    original_price: { type: Number, min: 0 },
    tier_label: { type: String, trim: true, default: null },
    discount_applied: { type: Boolean, default: false },
    discount_percent: { type: Number, default: 0, min: 0 },
    discount_amount_per_unit: { type: Number, default: 0, min: 0 },
    discount_source: {
      type: String,
      enum: ["pantry", "cibox_plus", null],
      default: null,
    },
    subtotal: { type: Number, required: true, min: 0 },
    original_subtotal: { type: Number, min: 0 },
    product_type: {
      type: String,
      enum: ["simple", "box"],
      default: "simple",
    },
    box_items: {
      type: [orderBoxItemSchema],
      default: [],
    },
    // Trazabilidad de lotes consumidos en el pick (capa aditiva FEFO por lote).
    // Best-effort: vacío para productos legacy sin lotes. Ver Fase B inventario.
    batches: {
      type: [
        new mongoose.Schema(
          {
            batch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Batch" },
            lot_code: { type: String, default: "", trim: true },
            qty: { type: Number, default: 0, min: 0 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    weight: {
      value: { type: Number, default: 0, min: 0 },
      unit: { type: String, default: "g" },
    },
    dimensions: {
      length: { type: Number, default: 0, min: 0 },
      width: { type: Number, default: 0, min: 0 },
      height: { type: Number, default: 0, min: 0 },
      unit: { type: String, default: "cm" },
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    guest_id: { type: String, default: null },
    guest_token_hash: { type: String, default: null, select: false },
    items: { type: [orderItemSchema], default: [] },
    customer: {
      fullName: { type: String, default: null, trim: true },
      email: { type: String, default: null, trim: true, lowercase: true },
      phone: { type: String, default: null, trim: true },
      rut: { type: String, default: null, trim: true },
    },
    // Asignación MANUAL de la preparación (admin/manager): este pedido debe
    // prepararlo una persona específica. null = cola común.
    assigned_to: {
      type: new mongoose.Schema(
        {
          user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          label: { type: String, default: "", trim: true },
        },
        { _id: false }
      ),
      default: null,
    },
    // Preparación: avance persistido (sobrevive recargas y permite que otra persona
    // continúe), faltantes detectados en el estante y cierre de empaque (bultos + peso).
    pick_progress: { type: [String], default: [] }, // product_ids confirmados (pickeados)
    pick_scanned: { type: [String], default: [] },  // subset confirmado por ESCÁNER
    faltantes: {
      type: [new mongoose.Schema({
        product_id: { type: String },
        name: { type: String, default: "" },
        qty_real: { type: Number, default: 0 },
        motivo: { type: String, default: "" },
        by: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      }, { _id: false })],
      default: [],
    },
    needs_review: { type: Boolean, default: false }, // hubo faltante/dañado → revisar
    packing: {
      bultos: { type: Number, default: null, min: 0 },
      peso: { type: Number, default: null, min: 0 },
    },
    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.PENDING,
    },
    source: {
      type: String,
      enum: ["custom_box", "cart", "direct_product", "box", "manual"],
      default: "cart",
    },
    delivery_method: {
      type: String,
      enum: ["delivery", "pickup"],
      default: "delivery",
      index: true,
    },
    pickup: {
      committed_date: { type: Date, default: null, index: true },
      // Snapshot de la dirección de retiro al crear el pedido. El default lo
      // fija orderService desde config/brand.js (fuente de verdad de la marca).
      location: { type: String, default: "" },
      picked_up_at: { type: Date, default: null },
    },
    payment: {
      method: {
        type: String,
        // "credito": venta a crédito en caja (genera Deuda; no entra al efectivo esperado).
        enum: ["webpay", "transfer", "cash_on_pickup", "card", "credito"],
        default: "webpay",
      },
      platform: {
        type: String,
        enum: ["ios", "android", "web", "native"],
        default: "web",
      },
      status: {
        type: String,
        enum: Object.values(PAYMENT_STATUS),
        default: PAYMENT_STATUS.PENDING,
      },
      transaction_id: { type: String, default: null },
      token: { type: String, default: null },
      buy_order: { type: String, default: null },
      session_id: { type: String, default: null },
      amount: { type: Number, default: 0, min: 0 },
      // Pago en efectivo (contra entrega / al retirar): monto recibido en mano y
      // vuelto entregado. null cuando no aplica / no se registró.
      amount_received: { type: Number, default: null, min: 0 },
      change: { type: Number, default: null, min: 0 },
      authorization_code: { type: String, default: null },
      response_code: { type: Number, default: null },
      transaction_date: { type: Date, default: null },
      webhook_processed_at: { type: Date, default: null },
      // Guard de idempotencia SOLO de los side-effects de pago aprobado
      // (boleta SII, emails, envío). Distinto de webhook_processed_at, que
      // finalizePaidOrder usa para marcar la orden como finalizada.
      side_effects_at: { type: Date, default: null },
      // Comprobante de transferencia (pago manual): URL de la imagen que sube el
      // cliente. El admin lo verifica y marca la orden pagada (markAsPaid).
      transfer_receipt_url: { type: String, default: null },
      transfer_receipt_uploaded_at: { type: Date, default: null },
    },
    shipping: {
      // No required a nivel schema: en pickup van vacíos (validación de
      // negocio en orderService según delivery_method). Delivery sigue
      // exigiéndolos en el validador/servicio (retrocompatible).
      region: { type: String, default: null, trim: true },
      city: { type: String, default: null, trim: true },
      address: { type: String, default: null, trim: true },
      addressLine2: { type: String, default: null, trim: true },
      reference: { type: String, default: null, trim: true },
      amount: { type: Number, default: 0, min: 0 },
      carrier: { type: String, default: "blueexpress_manual" },
      service_name: { type: String, default: null },
      service_code: { type: String, default: null },
      tracking_number: { type: String, default: null },
      shipment_status: { type: String, default: null },
      label_url: { type: String, default: null },
      estimated_delivery: { type: Date, default: null },
      last_event_at: { type: Date, default: null },
      last_synced_at: { type: Date, default: null },
      events: {
        type: [
          {
            status: { type: String, default: null },
            at: { type: Date, default: Date.now },
            raw: { type: mongoose.Schema.Types.Mixed, default: null },
            _id: false,
          },
        ],
        default: [],
      },
    },
    coupon: {
      code: { type: String, default: null },
      coupon_id: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", default: null },
      discount_amount: { type: Number, default: 0, min: 0 },
    },
    subtotal: { type: Number, required: true, default: 0, min: 0 },
    shipping_amount: { type: Number, required: true, default: 0, min: 0 },
    discount_amount: { type: Number, required: true, default: 0, min: 0 },
    total: { type: Number, required: true, default: 0, min: 0 },
    notes: { type: String, default: null, trim: true },
    paid_at: { type: Date, default: null },
    shipped_at: { type: Date, default: null },
    delivered_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
    cancellation_reason: { type: String, default: null, trim: true },
    // true cuando el stock descontado al crear la orden ya fue repuesto
    // (cancelación/expiración/reembolso total). Hace idempotente la reposición.
    stock_restored: { type: Boolean, default: false },
    // true cuando el físico ya SALIÓ de bodega en el pick (preparing→ready).
    // Antes del pick la orden solo tiene stock comprometido (allocated), no
    // descontado. Decide si cancelar/reembolsar repone físico o libera allocated.
    stock_committed: { type: Boolean, default: false },
    // Acumulado de reembolsos parciales aprobados (refundService.approveRefund).
    // Sin este campo, el set se descartaba en silencio por el strict mode de Mongoose.
    partial_refunded_amount: { type: Number, default: 0, min: 0 },
    status_history: {
      type: [
        {
          status: { type: String, enum: Object.values(ORDER_STATUS) },
          changed_at: { type: Date, default: Date.now },
          note: { type: String, default: null, trim: true },
          changed_by: {
            user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            role: { type: String, default: null },
            label: { type: String, default: null, trim: true },
          },
          _id: false,
        },
      ],
      default: [],
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.guest_token_hash;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.guest_token_hash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

orderSchema.index({ user_id: 1, created_at: -1 });
orderSchema.index({ guest_id: 1, created_at: -1 });
orderSchema.index({ "payment.token": 1 });
orderSchema.index({ "payment.buy_order": 1 });
orderSchema.index({ "items.product_id": 1 });
orderSchema.index({ status: 1, created_at: -1 });
orderSchema.index({ "payment.status": 1, created_at: -1 });
// Agenda de retiros en bodega: filtrar por método, fecha comprometida y estado.
orderSchema.index({ delivery_method: 1, "pickup.committed_date": 1, status: 1 });
// adminListOrders sin filtro de status ordena por created_at desc (caso por
// defecto del listado del WMS): índice dedicado para sort + skip eficientes.
orderSchema.index({ created_at: -1 });

export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export default Order;