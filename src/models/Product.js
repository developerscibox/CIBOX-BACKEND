import mongoose from "mongoose";
import { normalizeText } from "../utils/text.js";

const pricingTierSchema = new mongoose.Schema(
  {
    min_qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    label: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const boxItemSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: { type: Number, required: true, min: 1, default: 1 },
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    vendor: {
      id: {
        type: String,
        required: true,
        index: true,
      },
      name: { type: String, required: true, trim: true },
    },

    product_type: {
      type: String,
      enum: ["simple", "box"],
      default: "simple",
    },

    name: { type: String, required: true, trim: true },
    images: { type: [String], default: [] },
    thumbnail: { type: String, default: "" },

    search_name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    description: { type: String, required: true, trim: true },

    // Categoría primaria (para display y backward-compat)
    category: {
      id: { type: String, required: true, trim: true },
      name: { type: String, required: true, trim: true },
    },

    // Todas las categorías asignadas explícitamente (mínimo 1)
    categories: {
      type: [
        {
          id: { type: String, required: true, trim: true },
          name: { type: String, required: true, trim: true },
          _id: false,
        },
      ],
      default: [],
    },

    // IDs de todas las categorías (hijos + padres resueltos) — usado para filtrado
    category_ids: {
      type: [String],
      default: [],
      index: true,
    },

    pricing: {
      tiers: {
        type: [pricingTierSchema],
        default: [],
        validate: {
          validator: (value) => Array.isArray(value) && value.length > 0,
          message: "El producto debe tener al menos un tier de precio",
        },
      },
      min_price: { type: Number, default: 0, min: 0 },
    },

    box_items: {
      type: [boxItemSchema],
      default: [],
      validate: {
        validator: function (value) {
          if (this.product_type !== "box") return true;
          return Array.isArray(value) && value.length >= 2;
        },
        message: "La caja debe tener al menos 2 productos",
      },
    },

    stock: { type: Number, required: true, default: 0, min: 0 },

    // Punto de reorden (reposición por stock mínimo). min_stock=0 ⇒ el producto
    // NO participa de reposición (opt-in explícito). Ambos en UNIDADES.
    min_stock: { type: Number, default: 0, min: 0 },
    // Nivel objetivo al reponer; si 0 se usa 2*min_stock como objetivo.
    target_stock: { type: Number, default: 0, min: 0 },

    // Unidades retenidas por carritos activos (reserva temporal, contador
    // desnormalizado). NO es stock físico: DISPONIBLE = stock − reserved.
    // El físico (stock) se descuenta recién al confirmar la orden.
    reserved: { type: Number, default: 0, min: 0 },

    // Unidades COMPROMETIDAS a órdenes confirmadas pero aún no pickeadas: el
    // físico (stock) sigue en bodega hasta el pick (Fase 4 — inventario en 3
    // estados). DISPONIBLE = stock − reserved − allocated.
    allocated: { type: Number, default: 0, min: 0 },

    // Fecha de vencimiento más próxima del stock en bodega (control de caducidad
    // ligero, sin lotes). Se setea al recibir mercadería o al editar el producto.
    expiry_date: { type: Date, default: null },

    is_active: { type: Boolean, default: true },
    featured: {
      type: Boolean,
      default: false,
      index: true,
    },

    cibox_plus: {
      enabled: { type: Boolean, default: false },
    },

    average_rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews_count: { type: Number, default: 0, min: 0 },

    sku: { type: String, trim: true, default: "" },
    brand: { type: String, trim: true, default: "" },

    // Código de barras (EAN-13 del fabricante o interno) — validación de picking por escaneo
    barcode: { type: String, trim: true, default: "" },

    // Ubicación física en bodega: pasillo/zona - rack - nivel
    location: {
      zone: { type: String, trim: true, default: "" },
      rack: { type: String, trim: true, default: "" },
      level: { type: String, trim: true, default: "" },
      code: { type: String, trim: true, default: "" }, // ej: "A-03-2", visible al preparar
    },

    // Precio de referencia en supermercado tradicional (para mostrar ahorro)
    compare_price: { type: Number, default: 0, min: 0 },

    // Costo de compra unitario (para margen/rentabilidad). Solo visible en el WMS
    // (admin/gerente con products.manage); nunca se expone en la tienda pública.
    cost_price: { type: Number, default: 0, min: 0 },

    weight: {
      value: { type: Number, min: 0, default: 0 },
      unit: { type: String, trim: true, default: "g" },
    },

    dimensions: {
      length: { type: Number, min: 0, default: 0 },
      width: { type: Number, min: 0, default: 0 },
      height: { type: Number, min: 0, default: 0 },
      unit: { type: String, trim: true, default: "cm" },
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

// Disponible para vender = físico − reservado por carritos (nunca negativo).
productSchema.virtual("available").get(function () {
  const stock = Number(this.stock || 0);
  const reserved = Number(this.reserved || 0);
  const allocated = Number(this.allocated || 0);
  return Math.max(0, stock - reserved - allocated);
});

productSchema.pre("save", function () {
  // Normalizar search_name: sin tildes, sin mayúsculas
  if (this.name) {
    this.search_name = normalizeText(this.name);
  }

  // Calcular precio mínimo
  if (Array.isArray(this.pricing?.tiers) && this.pricing.tiers.length > 0) {
    const prices = this.pricing.tiers.map((t) => Number(t.price || 0));
    this.pricing.min_price = Math.min(...prices);
  } else {
    this.pricing = this.pricing || {};
    this.pricing.min_price = 0;
  }
});

productSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;

  const tiers = $set?.pricing?.tiers;

  if (Array.isArray(tiers) && tiers.length > 0) {
    const minPrice = Math.min(...tiers.map((t) => Number(t.price || 0)));

    if (update.$set) {
      update.$set["pricing.min_price"] = minPrice;
    } else {
      update["pricing.min_price"] = minPrice;
    }

    this.setUpdate(update);
  }
});

productSchema.index({ is_active: 1, "category.id": 1 });       // backward-compat
productSchema.index({ is_active: 1, category_ids: 1 });          // filtrado multi-cat
productSchema.index({ is_active: 1, "vendor.id": 1 });
productSchema.index({ search_name: "text" });
productSchema.index({ is_active: 1, "pricing.min_price": 1 });
productSchema.index(
  { barcode: 1 },
  { partialFilterExpression: { barcode: { $gt: "" } } }
); // lookup por escaneo, solo indexa productos con código
productSchema.index({ "location.code": 1 });
productSchema.index(
  { is_active: 1, expiry_date: 1 },
  { partialFilterExpression: { expiry_date: { $type: "date" } } }
); // alerta de productos por vencer (FEFO ligero)
productSchema.index(
  { is_active: 1, min_stock: 1 },
  { partialFilterExpression: { min_stock: { $gt: 0 } } }
); // reposición: solo indexa productos con punto de reorden definido

export const Product =
  mongoose.models.Product || mongoose.model("Product", productSchema);
export default Product;
