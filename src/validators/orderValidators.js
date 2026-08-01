import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

const customerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().min(8).max(20),
  rut: z.string().min(7).max(15),
});

const shippingSchema = z.object({
  region: z.string().min(2).max(80),
  city: z.string().min(2).max(80),
  address: z.string().min(5).max(200),
  addressLine2: z.string().max(120).optional().nullable(),
  reference: z.string().max(200).optional().nullable(),
});

// En pickup el shipping es opcional (y sus campos también). La validación de
// negocio (delivery exige shipping; pickup exige committed_date) vive en
// orderService para mantener un único punto de verdad.
const shippingPickupSchema = z.object({
  region: z.string().max(80).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  address: z.string().max(200).optional().nullable(),
  addressLine2: z.string().max(120).optional().nullable(),
  reference: z.string().max(200).optional().nullable(),
});

const paymentSchema = z
  .object({
    method: z.enum(["webpay", "transfer", "cash_on_pickup"]).optional(),
    platform: z.enum(["ios", "android", "web", "native"]).optional(),
  })
  .optional();

// Fecha comprometida de retiro: YYYY-MM-DD o ISO 8601.
const committedDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}($|T)/,
    "committed_date debe ser YYYY-MM-DD o ISO 8601",
  );

const deliverySchema = z
  .object({
    method: z.enum(["delivery", "pickup"]).optional(),
    committed_date: committedDateSchema.optional().nullable(),
  })
  .optional();

export const createFromCartSchema = {
  body: z.object({
    customer: customerSchema,
    // shipping opcional a nivel zod: si delivery=delivery se exige en el
    // servicio. shippingPickupSchema relaja los mínimos para pickup.
    shipping: shippingPickupSchema.optional(),
    delivery: deliverySchema,
    payment: paymentSchema,
    notes: z.string().max(500).optional().nullable(),
    couponCode: z.string().min(2).max(40).optional().nullable(),
  }),
};

const customBoxItemSchema = z.object({
  product_id: objectId,
  quantity: z.coerce.number().int().min(1).max(999),
});

export const createFromCustomBoxSchema = {
  body: z.object({
    items: z.array(customBoxItemSchema).min(1).max(50),
    customer: customerSchema,
    shipping: shippingSchema,
    payment: paymentSchema,
    notes: z.string().max(500).optional().nullable(),
    couponCode: z.string().min(2).max(40).optional().nullable(),
  }),
};

export const cancelOrderSchema = {
  params: z.object({ id: objectId }),
  body: z
    .object({
      reason: z.string().max(300).optional().nullable(),
      guestToken: z.string().min(32).max(128).optional().nullable(),
    })
    .optional(),
};

export const orderIdParamSchema = {
  params: z.object({ id: objectId }),
};

export const guestOrderLookupSchema = {
  params: z.object({ id: objectId }),
  query: z.object({
    token: z.string().min(32).max(128),
  }),
};

export const retryPaymentSchema = {
  params: z.object({ id: objectId }),
  body: z
    .object({
      platform: z.enum(["ios", "android", "web", "native"]).optional(),
      guestToken: z.string().min(32).max(128).optional().nullable(),
    })
    .optional(),
};

// receipt_url es opcional: el comprobante también puede venir como archivo
// multipart (campo "receipt") que el backend sube vía uploadService — el
// cliente no tiene permiso products.manage para usar POST /uploads/image.
export const transferReceiptSchema = {
  params: z.object({ id: objectId }),
  body: z
    .object({
      receipt_url: z.string().url().max(500).optional().nullable(),
      guestToken: z.string().min(32).max(128).optional().nullable(),
    })
    .optional(),
};

export const adminPayCashSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    // Monto recibido en mano (CLP, entero). La validación >= total vive en el
    // servicio (depende del total de la orden).
    amount_received: z.coerce.number().int().min(0).max(99999999),
  }),
};

export const adminUpdateStatusSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    status: z.enum(["pending", "paid", "preparing", "ready", "shipped", "delivered", "cancelled", "refunded"]),
    tracking_number: z.string().trim().max(100).optional().nullable(),
    note: z.string().trim().max(300).optional().nullable(),
  }),
};
