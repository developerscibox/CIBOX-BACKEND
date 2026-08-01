import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "ID inválido");

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug requerido")
  .max(120, "Slug demasiado largo")
  .regex(/^[a-z0-9-]+$/, "Slug solo permite minúsculas, números y guiones");

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(120),
  slug: slugSchema.optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  image_url: z.string().trim().max(2048).url("URL inválida").optional().nullable(),
  parent_id: objectIdSchema.optional().nullable(),
  is_active: z.boolean().optional(),
  is_featured: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(99999).optional(),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: slugSchema.optional(),
    description: z.string().trim().max(1000).optional().nullable(),
    image_url: z.string().trim().max(2048).url("URL inválida").optional().nullable(),
    parent_id: objectIdSchema.optional().nullable(),
    is_active: z.boolean().optional(),
    is_featured: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(99999).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debes enviar al menos un campo a actualizar",
  });

export const listCategoriesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  parent_id: z.union([objectIdSchema, z.literal("null"), z.literal("")]).optional(),
  is_active: z.union([z.literal("true"), z.literal("false")]).optional(),
  is_featured: z.union([z.literal("true"), z.literal("false")]).optional(),
  tree: z.union([z.literal("true"), z.literal("false")]).optional(),
  search: z.string().trim().max(120).optional(),
});

export const categoryParamsSchema = z.object({
  id: objectIdSchema,
});

export const categorySlugParamsSchema = z.object({
  slug: slugSchema,
});
