import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

export const validateCouponSchema = {
  body: z.object({
    code: z.string().min(2).max(40),
    subtotal: z.coerce.number().min(0).optional(),
  }),
};

export const adminCreateCouponSchema = {
  body: z
    .object({
      code: z.string().min(2).max(40),
      discount_type: z.enum(["percent", "fixed"]),
      discount_value: z.coerce.number().min(0),
      min_subtotal: z.coerce.number().min(0).optional(),
      max_discount: z.coerce.number().min(0).optional().nullable(),
      starts_at: z.coerce.date().optional().nullable(),
      expires_at: z.coerce.date().optional().nullable(),
      max_uses: z.coerce.number().int().min(1).optional().nullable(),
      max_uses_per_user: z.coerce.number().int().min(1).optional(),
      first_purchase_only: z.boolean().optional(),
      is_active: z.boolean().optional(),
    })
    .superRefine((val, ctx) => {
      if (val.discount_type === "percent" && val.discount_value > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["discount_value"],
          message: "El descuento porcentual no puede exceder 100",
        });
      }
    }),
};

export const adminUpdateCouponSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    discount_type: z.enum(["percent", "fixed"]).optional(),
    discount_value: z.coerce.number().min(0).optional(),
    min_subtotal: z.coerce.number().min(0).optional(),
    max_discount: z.coerce.number().min(0).optional().nullable(),
    starts_at: z.coerce.date().optional().nullable(),
    expires_at: z.coerce.date().optional().nullable(),
    max_uses: z.coerce.number().int().min(1).optional().nullable(),
    max_uses_per_user: z.coerce.number().int().min(1).optional(),
    first_purchase_only: z.boolean().optional(),
    is_active: z.boolean().optional(),
  }),
};

export const couponIdParamSchema = {
  params: z.object({ id: objectId }),
};
