import { z } from "zod";
import mongoose from "mongoose";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .refine((v) => mongoose.Types.ObjectId.isValid(v), {
    message: "ID inválido",
  });

// Los tramos de precio ya NO se envían: el modelo los deriva de `price` y
// `pack_size` (ver models/Product.js). El catálogo de supermercado tiene un
// precio por producto.

const SALE_UNITS = ["unidad", "kg", "g", "l", "ml", "pack", "caja", "bandeja", "docena"];

const priceFields = {
  // Precio de venta al público CON IVA incluido.
  price: z.number().nonnegative(),
  sale_unit: z.enum(SALE_UNITS).default("unidad"),
  unit_content: z
    .object({
      value: z.number().nonnegative().optional(),
      unit: z.string().trim().max(10).optional(),
    })
    .optional(),
  // Precio por unidad de medida (decreto 38/2024). Solo entradas: `value`,
  // `unit_label` y `text` los deriva el modelo y se rechazan si llegan.
  ppum: z
    .object({
      mode: z.enum(["auto", "exempt"]).optional(),
      exempt_reason: z.string().trim().max(60).optional(),
      net_value: z.number().nonnegative().optional(),
      net_unit: z.string().trim().max(12).optional(),
      drained_value: z.number().nonnegative().optional(),
      pieces_per_pack: z.number().int().nonnegative().optional(),
      length_per_piece_m: z.number().nonnegative().optional(),
      bulk: z.boolean().optional(),
      preset: z.string().trim().max(20).optional(),
    })
    .strict("Los campos derivados del PPUM no se editan a mano")
    .refine((v) => v.mode !== "exempt" || Boolean(v.exempt_reason), {
      message: "Un producto exceptuado del PPUM debe indicar el motivo (art. 8° del decreto 38/2024)",
    })
    .optional(),
  // Venta por pack/caja: 0 o 1 = venta unitaria.
  pack_size: z.number().int().nonnegative().optional(),
  pack_price: z.number().nonnegative().optional(),
  tax: z
    .object({
      afecto: z.boolean().optional(),
      iva_pct: z.number().min(0).max(100).optional(),
    })
    .optional(),
};

const categorySchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
});

const vendorRefSchema = z.object({
  id: objectIdSchema,
  name: z.string().trim().min(1).max(200),
});

const baseCreate = {
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().min(1).max(5000),
  ...priceFields,
  category: categorySchema,
  subcategory: categorySchema.optional(),
  images: z.array(z.string().trim().url()).max(20).default([]),
  thumbnail: z.string().trim().url().optional(),
  stock: z.number().int().nonnegative().default(0),
  // Reposición por stock mínimo (unidades, enteros ≥ 0, opcionales).
  min_stock: z.number().int().nonnegative().optional(),
  target_stock: z.number().int().nonnegative().optional(),
  is_active: z.boolean().optional(),
  // SKU del catálogo. Si no viene, el modelo genera uno.
  sku: z.string().trim().max(100).optional(),
  barcode: z.string().trim().max(64).optional(),
  brand: z.string().trim().max(100).optional(),
  product_type: z.enum(["simple", "box"]).default("simple"),
  vendor: vendorRefSchema.optional(),
  weight: z
    .object({
      value: z.number().nonnegative().optional(),
      unit: z.string().trim().max(10).optional(),
    })
    .optional(),
  dimensions: z
    .object({
      length: z.number().nonnegative().optional(),
      width: z.number().nonnegative().optional(),
      height: z.number().nonnegative().optional(),
      unit: z.string().trim().max(10).optional(),
    })
    .optional(),
  box_items: z
    .array(
      z.object({
        product_id: objectIdSchema,
        quantity: z.number().int().min(1).default(1),
      }),
    )
    .optional(),
  // Costo de compra unitario (margen). Solo visible en el WMS, nunca en tienda.
  cost_price: z.number().nonnegative().optional(),
  // Vencimiento del stock (control de caducidad ligero). Fecha ISO o null.
  expiry_date: z
    .union([z.string().datetime({ offset: true }), z.string().date(), z.null()])
    .optional(),
};

export const createProductSchema = z.object(baseCreate);

export const updateProductSchema = z
  .object({
    name: baseCreate.name.optional(),
    description: baseCreate.description.optional(),
    price: baseCreate.price.optional(),
    sale_unit: z.enum(SALE_UNITS).optional(),
    unit_content: baseCreate.unit_content,
    ppum: baseCreate.ppum,
    pack_size: baseCreate.pack_size,
    pack_price: baseCreate.pack_price,
    tax: baseCreate.tax,
    category: categorySchema.optional(),
    subcategory: categorySchema.optional(),
    images: z.array(z.string().trim().url()).max(20).optional(),
    // "" permitido para QUITAR la foto desde el panel (el modelo defaultea "").
    thumbnail: z.union([z.string().trim().url(), z.literal("")]).optional(),
    stock: z.number().int().nonnegative().optional(),
    min_stock: baseCreate.min_stock,
    target_stock: baseCreate.target_stock,
    sku: z.string().trim().max(100).optional(),
    barcode: baseCreate.barcode,
    brand: z.string().trim().max(100).optional(),
    weight: baseCreate.weight,
    dimensions: baseCreate.dimensions,
    box_items: baseCreate.box_items,
    product_type: z.enum(["simple", "box"]).optional(),
    cost_price: baseCreate.cost_price,
    expiry_date: baseCreate.expiry_date,
  })
  .strict("Campo no permitido para vendor");

export const adminUpdateProductSchema = z
  .object({
    name: baseCreate.name.optional(),
    description: baseCreate.description.optional(),
    price: baseCreate.price.optional(),
    sale_unit: z.enum(SALE_UNITS).optional(),
    unit_content: baseCreate.unit_content,
    ppum: baseCreate.ppum,
    pack_size: baseCreate.pack_size,
    pack_price: baseCreate.pack_price,
    tax: baseCreate.tax,
    category: categorySchema.optional(),
    subcategory: categorySchema.optional(),
    images: z.array(z.string().trim().url()).max(20).optional(),
    // "" permitido para QUITAR la foto desde el panel (el modelo defaultea "").
    thumbnail: z.union([z.string().trim().url(), z.literal("")]).optional(),
    stock: z.number().int().nonnegative().optional(),
    min_stock: baseCreate.min_stock,
    target_stock: baseCreate.target_stock,
    sku: z.string().trim().max(100).optional(),
    barcode: baseCreate.barcode,
    brand: z.string().trim().max(100).optional(),
    weight: baseCreate.weight,
    dimensions: baseCreate.dimensions,
    box_items: baseCreate.box_items,
    product_type: z.enum(["simple", "box"]).optional(),
    is_active: z.boolean().optional(),
    cibox_plus: z.object({ enabled: z.boolean() }).optional(),
    cost_price: baseCreate.cost_price,
    expiry_date: baseCreate.expiry_date,
  })
  .strict("Campo no permitido");

export const listProductsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  vendor: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  min_price: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  max_price: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  sort: z
    .enum(["price_asc", "price_desc", "newest", "oldest", "rating", "popular"])
    .optional(),
  is_active: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  product_type: z.enum(["simple", "box"]).optional(),
  // Filtros opcionales (WMS / catálogo). Mantienen compatibilidad total.
  in_stock: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  include_inactive: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
});

export const validateBoxItemsSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: objectIdSchema,
        quantity: z.number().int().min(1),
      }),
    )
    .min(1, "Debe enviar al menos un item")
    .superRefine((items, ctx) => {
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        const id = String(items[i].product_id);
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "product_id"],
            message: "product_id duplicado",
          });
        }
        seen.add(id);
      }
    }),
});

// ── Importación masiva de SKUs ────────────────────────────────────────────────
// Celdas vacías de un CSV llegan como "" o null → se tratan como "no presente".
const emptyToUndef = (v) => (v === "" || v === null ? undefined : v);
const optionalString = (max) =>
  z.preprocess(emptyToUndef, z.coerce.string().trim().max(max).optional());
const optionalNumber = (inner) => z.preprocess(emptyToUndef, inner.optional());

/**
 * Schema de UNA fila de importación. Se aplica POR FILA en el controller
 * (safeParse) para que una fila inválida no aborte el resto del archivo.
 */
export const importBulkRowSchema = z.object({
  sku: optionalString(100),
  barcode: optionalString(64),
  // OJO: sin z.coerce — coerce convierte undefined en el string "undefined"
  // (pasa el min(2)) y una fila sin nombre crearía un producto "undefined".
  name: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : String(v)),
    z.string({ required_error: "falta name (obligatorio)" }).trim().min(2, "name muy corto").max(200),
  ),
  category_name: optionalString(200),
  subcategory_name: optionalString(200),
  price: optionalNumber(z.coerce.number().positive("price debe ser > 0")),
  sale_unit: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : String(v).toLowerCase().trim()),
    z.enum(SALE_UNITS, { errorMap: () => ({ message: `sale_unit debe ser uno de: ${SALE_UNITS.join(", ")}` }) }).optional(),
  ),
  content_value: optionalNumber(z.coerce.number().nonnegative()),
  content_unit: optionalString(10),
  // Compatibilidad: box_qty/box_price se aceptan como alias de pack_size/pack_price.
  pack_size: optionalNumber(z.coerce.number().int().min(1)),
  pack_price: optionalNumber(z.coerce.number().nonnegative()),
  box_qty: optionalNumber(z.coerce.number().int().min(1)),
  box_price: optionalNumber(z.coerce.number().nonnegative()),
  iva_afecto: z.preprocess(
    (v) => {
      if (v === "" || v === null || v === undefined) return undefined;
      const t = String(v).toLowerCase().trim();
      if (["si", "sí", "true", "1", "s"].includes(t)) return true;
      if (["no", "false", "0", "n"].includes(t)) return false;
      return v;
    },
    z.boolean().optional(),
  ),
  cost_price: optionalNumber(z.coerce.number().nonnegative()),
  stock_inicial: optionalNumber(z.coerce.number().int().nonnegative()),
  min_stock: optionalNumber(z.coerce.number().int().nonnegative()),
  target_stock: optionalNumber(z.coerce.number().int().nonnegative()),
  brand: optionalString(100),
  description: optionalString(5000),
});

/**
 * Envelope del import masivo: valida la forma general y el tope de 500 filas.
 * El detalle de cada fila lo valida el controller con importBulkRowSchema.
 */
export const importBulkSchema = z.object({
  rows: z
    .array(z.record(z.any()), { required_error: "rows requerido" })
    .min(1, "Debe enviar al menos una fila")
    .max(500, "Máximo 500 filas por importación"),
  dry_run: z.boolean().optional().default(false),
});

export const productIdParamSchema = z.object({ id: objectIdSchema });
export const vendorIdParamSchema = z.object({ vendorId: objectIdSchema });
export const categoryIdParamSchema = z.object({
  categoryId: z.string().trim().min(1),
});
