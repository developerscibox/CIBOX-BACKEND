import mongoose from "mongoose";
import { normalizeText } from "../utils/text.js";
import { brand } from "../config/brand.js";
import { buildTiers } from "../catalogo/precio.js";

const DEFAULT_IVA_PCT = brand.legal.iva_pct;

// SKU automático para productos que llegan sin uno (import masivo, legado).
// Prefijo de marca + base36 del instante + 3 hex: legible y único en la práctica.
const autoSku = () =>
  `${String(brand.name).slice(0, 3).toUpperCase()}-${Date.now().toString(36).toUpperCase()}${Math.floor(
    Math.random() * 4096,
  )
    .toString(16)
    .toUpperCase()
    .padStart(3, "0")}`;

// Tramo de precio por cantidad. Ya NO se edita a mano: lo deriva buildTiers()
// desde `price` / `pack_size` (ver catalogo/precio.js).
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

    // Subcategoría: segundo nivel del árbol (Category.parent_id). Opcional:
    // un producto puede colgar solo de la categoría raíz.
    subcategory: {
      id: { type: String, default: "", trim: true },
      name: { type: String, default: "", trim: true },
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

    // ── Precio de venta al público, CON IVA incluido ─────────────────────────
    // Es la fuente de verdad del precio del producto. `pricing.tiers` se deriva
    // de aquí en el pre-save: el tier de unidad siempre existe y, si el producto
    // se vende por pack/caja, se agrega el tier del pack. Así el catálogo es de
    // supermercado (un precio por producto) sin romper el motor de precios por
    // tramos que usan carrito, despensa y checkout.
    price: { type: Number, default: 0, min: 0 },

    // Unidad de venta: cómo se vende el producto al cliente.
    sale_unit: {
      type: String,
      enum: ["unidad", "kg", "g", "l", "ml", "pack", "caja", "bandeja", "docena"],
      default: "unidad",
    },
    // Contenido declarado del envase: 1.5 L, 500 g, 6 un. Es informativo (va en
    // la ficha y en el nombre corto), no interviene en el precio.
    unit_content: {
      value: { type: Number, default: 0, min: 0 },
      unit: { type: String, trim: true, default: "" },
    },
    // Unidades por pack/caja cuando la venta es por bulto. 0 o 1 = venta unitaria.
    pack_size: { type: Number, default: 0, min: 0 },
    // Precio del pack completo. Si es 0 y hay pack_size, se calcula price × pack_size.
    pack_price: { type: Number, default: 0, min: 0 },

    // IVA. En Chile la mayoría de los alimentos son afectos al 19%; el default
    // sale de brand.legal.iva_pct. Los precios se guardan CON IVA incluido.
    tax: {
      afecto: { type: Boolean, default: true },
      iva_pct: { type: Number, default: DEFAULT_IVA_PCT, min: 0, max: 100 },
    },

    pricing: {
      // Derivado de `price` / `pack_price` en el pre-save. No se edita a mano
      // desde el panel: es el formato que consumen pricingService y el carrito.
      tiers: { type: [pricingTierSchema], default: [] },
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

    // SKU interno. Único cuando existe; si llega vacío, el pre-save genera uno.
    sku: { type: String, trim: true, default: "", uppercase: true },
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

  // SKU: obligatorio de hecho. Si no vino, se genera uno.
  if (!this.sku) this.sku = autoSku();

  this.pricing = this.pricing || {};

  // Compatibilidad hacia atrás: producto legado con tiers pero sin `price`
  // (catálogo mayorista anterior) → el precio unitario es el tier de min_qty 1.
  if (!(Number(this.price) > 0) && Array.isArray(this.pricing.tiers) && this.pricing.tiers.length) {
    const unitTier = [...this.pricing.tiers].sort((a, b) => a.min_qty - b.min_qty)[0];
    this.price = Number(unitTier?.price || 0);
  }

  // Los tramos SIEMPRE se derivan del precio: una sola fuente de verdad.
  this.pricing.tiers = buildTiers({
    price: this.price,
    packSize: this.pack_size,
    packPrice: this.pack_price,
    saleUnit: this.sale_unit,
  });
  this.pricing.min_price = Math.min(...this.pricing.tiers.map((t) => Number(t.price || 0)));
});

/**
 * Mantiene `pricing` coherente cuando se actualiza por query (el panel usa
 * findOneAndUpdate). Si el update toca precio, pack o unidad de venta, se
 * regeneran los tramos desde el documento resultante.
 */
productSchema.pre("findOneAndUpdate", async function () {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  const toca = ["price", "pack_size", "pack_price", "sale_unit"].some((k) => $set?.[k] !== undefined);
  if (!toca) return;

  const actual = await this.model.findOne(this.getQuery()).select("price pack_size pack_price sale_unit").lean();
  const merged = {
    price: $set.price ?? actual?.price ?? 0,
    packSize: $set.pack_size ?? actual?.pack_size ?? 0,
    packPrice: $set.pack_price ?? actual?.pack_price ?? 0,
    saleUnit: $set.sale_unit ?? actual?.sale_unit ?? "unidad",
  };
  const tiers = buildTiers(merged);
  const minPrice = Math.min(...tiers.map((t) => Number(t.price || 0)));

  const target = update.$set ? update.$set : update;
  target["pricing.tiers"] = tiers;
  target["pricing.min_price"] = minPrice;
  this.setUpdate(update);
});

productSchema.index(
  { sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $gt: "" } } },
); // SKU único del catálogo (solo indexa los que lo tienen)
productSchema.index({ is_active: 1, "subcategory.id": 1 });      // filtro por subcategoría
productSchema.index({ is_active: 1, brand: 1 });                 // filtro por marca
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
