import mongoose from "mongoose";
import { normalizeText } from "../utils/text.js";
import { brand } from "../config/brand.js";
import { buildTiers } from "../catalogo/precio.js";
import { ppumDeProducto } from "../catalogo/ppum.js";

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
    // Precio por Unidad de Medida — decreto 38/2024 del Min. de Economía.
    // Lo que el consumidor ve ("$1.611 por kg") sale de `text`; `value` existe
    // para poder ordenar y comparar sin recalcular en cada pantalla.
    //
    // Los campos de entrada solo hacen falta cuando `unit_content` no alcanza:
    // rollos (el art. 11 n°5 exige metro), conservas con peso drenado (art. 10),
    // granel (art. 5°) y productos exceptuados (art. 8°).
    ppum: {
      // "auto" = se calcula; "exempt" = exceptuado, no se publica PPUM.
      mode: { type: String, enum: ["auto", "exempt"], default: "auto" },
      exempt_reason: { type: String, trim: true, default: "" },

      // Overrides de contenido. En 0/"" manda `unit_content`.
      net_value: { type: Number, default: 0, min: 0 },
      net_unit: { type: String, trim: true, default: "" },
      // Art. 10: peso escurrido o drenado, cuando el envase lo declara.
      drained_value: { type: Number, default: 0, min: 0 },
      // Art. 6°: piezas idénticas dentro del mismo envase.
      pieces_per_pack: { type: Number, default: 0, min: 0 },
      // Art. 11 n°5: metros por rollo. Sin esto, el papel se informa por unidad.
      length_per_piece_m: { type: Number, default: 0, min: 0 },
      // Art. 5°: producto a granel — el precio de venta ES el PPUM.
      bulk: { type: Boolean, default: false },
      // Art. 11: unidad preestablecida. Vacío = se resuelve por categoría.
      preset: { type: String, trim: true, default: "" },

      // ── Derivados. NO se editan a mano: los calcula el pre-save.
      value: { type: Number, default: 0, min: 0 },
      unit_label: { type: String, trim: true, default: "" },
      text: { type: String, trim: true, default: "" },
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

  // PPUM: mismo criterio que los tramos — se deriva, nunca se edita a mano.
  Object.assign(this.ppum || (this.ppum = {}), derivarPpum(this));
  // Al crear, y al pasar de despublicado a publicado, se exige PPUM. Editar un
  // producto que YA estaba activo no se bloquea (ver la función).
  exigirPpumParaPublicar({
    is_active: this.is_active,
    product_type: this.product_type,
    ppum: this.ppum,
    name: this.name,
    yaEstabaActivo: !this.isNew && !this.isModified("is_active"),
  });
});

/**
 * Un producto no se publica sin PPUM. Si de verdad está exceptuado (art. 8°),
 * hay que decirlo explícitamente con `ppum.mode = "exempt"`; lo que no se
 * permite es publicarlo y que el precio quede sin su unidad de medida.
 *
 * Solo bloquea al CREAR y al ACTIVAR. Un producto que ya estaba publicado sin
 * PPUM (catálogo heredado) se puede seguir editando: si bloqueáramos también
 * ahí, corregirle el precio a un producto viejo sería imposible desde el panel
 * y el operador quedaría sin salida. La deuda del catálogo se salda con
 * scripts/backfillPpum.js, no dejando la bodega sin poder trabajar.
 */
const exigirPpumParaPublicar = ({ is_active, product_type, ppum, name, yaEstabaActivo = false }) => {
  if (!is_active) return;
  if (yaEstabaActivo) return;
  if (product_type === "box") return; // art. 8° n°1
  if (ppum?.mode === "exempt") return;
  if (ppum?.text) return;

  throw new Error(
    `No se puede publicar "${name}" sin precio por unidad de medida (decreto 38/2024). ` +
      "Completa el contenido del envase y su unidad, o márcalo como exceptuado indicando el motivo.",
  );
};

/**
 * Campos derivados del PPUM. Devuelve siempre las tres claves para que un
 * producto que deja de ser calculable (le borraron el contenido, lo marcaron
 * exceptuado) limpie el valor anterior en vez de arrastrarlo.
 */
const derivarPpum = (doc) => {
  const ppum = ppumDeProducto(doc);
  return {
    value: ppum?.valor || 0,
    unit_label: ppum?.etiqueta || "",
    text: ppum?.texto || "",
  };
};

/**
 * Mantiene `pricing` coherente cuando se actualiza por query (el panel usa
 * findOneAndUpdate). Si el update toca precio, pack o unidad de venta, se
 * regeneran los tramos desde el documento resultante.
 */
productSchema.pre("findOneAndUpdate", async function () {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;

  const tocaPrecio = ["price", "pack_size", "pack_price", "sale_unit"].some((k) => $set?.[k] !== undefined);
  // El PPUM depende además del contenido, del nombre y de la categoría (el
  // preset del art. 11 se resuelve con ellos), así que su gatillo es más ancho.
  const tocaPpum = Object.keys($set || {}).some(
    (k) =>
      ["price", "name", "unit_content", "category", "subcategory"].includes(k) ||
      k.startsWith("unit_content.") ||
      k.startsWith("ppum.") ||
      k === "ppum",
  );
  if (!tocaPrecio && !tocaPpum) return;

  const actual = await this.model
    .findOne(this.getQuery())
    .select("price pack_size pack_price sale_unit name unit_content category subcategory ppum is_active product_type")
    .lean();

  const target = update.$set ? update.$set : update;

  if (tocaPrecio) {
    const tiers = buildTiers({
      price: $set.price ?? actual?.price ?? 0,
      packSize: $set.pack_size ?? actual?.pack_size ?? 0,
      packPrice: $set.pack_price ?? actual?.pack_price ?? 0,
      saleUnit: $set.sale_unit ?? actual?.sale_unit ?? "unidad",
    });
    target["pricing.tiers"] = tiers;
    target["pricing.min_price"] = Math.min(...tiers.map((t) => Number(t.price || 0)));
  }

  if (tocaPpum || $set?.is_active !== undefined) {
    const merged = mergeParaPpum(actual, $set);
    const derivado = derivarPpum(merged);
    target["ppum.value"] = derivado.value;
    target["ppum.unit_label"] = derivado.unit_label;
    target["ppum.text"] = derivado.text;

    exigirPpumParaPublicar({
      is_active: $set.is_active ?? actual?.is_active,
      product_type: $set.product_type ?? actual?.product_type,
      ppum: { ...merged.ppum, ...derivado },
      name: merged.name,
      yaEstabaActivo: Boolean(actual?.is_active),
    });
  }

  this.setUpdate(update);
});

/**
 * Documento resultante del update, solo con lo que el PPUM necesita. Acepta
 * tanto `{ ppum: {...} }` como la notación de punto `{ "ppum.bulk": true }`,
 * que es la que usa el panel.
 */
const mergeParaPpum = (actual, $set = {}) => {
  const ppum = { ...(actual?.ppum || {}), ...($set.ppum || {}) };
  const unitContent = { ...(actual?.unit_content || {}), ...($set.unit_content || {}) };

  for (const [clave, valor] of Object.entries($set)) {
    if (clave.startsWith("ppum.")) ppum[clave.slice(5)] = valor;
    if (clave.startsWith("unit_content.")) unitContent[clave.slice(13)] = valor;
  }

  return {
    price: $set.price ?? actual?.price ?? 0,
    name: $set.name ?? actual?.name ?? "",
    category: $set.category ?? actual?.category,
    subcategory: $set.subcategory ?? actual?.subcategory,
    unit_content: unitContent,
    ppum,
  };
};

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
