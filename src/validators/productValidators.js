import { z } from "zod";
import mongoose from "mongoose";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .refine((v) => mongoose.Types.ObjectId.isValid(v), {
    message: "ID inválido",
  });

const tierSchema = z.object({
  min_qty: z.number().int().positive(),
  price: z.number().nonnegative(),
  label: z.string().trim().min(1).max(100),
});

const tiersSchema = z
  .array(tierSchema)
  .min(1, "Debe existir al menos un tier")
  .superRefine((tiers, ctx) => {
    const minQtys = new Set();
    const quantities = new Set();
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      if (minQtys.has(t.min_qty)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "min_qty"],
          message: "min_qty duplicado",
        });
      }
      minQtys.add(t.min_qty);
      quantities.add(t.min_qty);
    }
    if (quantities.size !== tiers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "No se permiten quantities iguales entre tiers",
      });
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].min_qty <= tiers[i - 1].min_qty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "min_qty"],
          message: "min_qty debe ser ascendente entre tiers",
        });
      }
      if (tiers[i].price >= tiers[i - 1].price) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "price"],
          message: "El precio debe ser descendente al subir min_qty",
        });
      }
    }
  });

const pricingSchema = z.object({
  tiers: tiersSchema,
});

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
  pricing: pricingSchema,
  category: categorySchema,
  images: z.array(z.string().trim().url()).max(20).default([]),
  thumbnail: z.string().trim().url().optional(),
  stock: z.number().int().nonnegative().default(0),
  // Reposición por stock mínimo (unidades, enteros ≥ 0, opcionales).
  min_stock: z.number().int().nonnegative().optional(),
  target_stock: z.number().int().nonnegative().optional(),
  is_active: z.boolean().optional(),
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
    pricing: pricingSchema.optional(),
    category: categorySchema.optional(),
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
    pricing: pricingSchema.optional(),
    category: categorySchema.optional(),
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
  price: optionalNumber(z.coerce.number().positive("price debe ser > 0")),
  box_qty: optionalNumber(z.coerce.number().int().min(1)),
  box_price: optionalNumber(z.coerce.number().nonnegative()),
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
