import { z } from "zod";
import { MOVEMENT_TYPES, MANUAL_MOVEMENT_TYPES } from "../utils/constants.js";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "ID inválido");

export const listMovementsSchema = {
  query: z.object({
    product_id: objectId.optional(),
    order_id: objectId.optional(),
    type: z.enum(Object.values(MOVEMENT_TYPES)).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
};

export const adjustStockSchema = {
  body: z.object({
    product_id: objectId,
    delta: z.coerce
      .number()
      .int()
      .refine((v) => v !== 0, "delta debe ser distinto de 0"),
    reason: z.string().min(3).max(300),
    // Tipo del movimiento. Sin él se infiere por el signo (entrada / ajuste);
    // la merma siempre se declara para que el informe no dependa del texto.
    type: z.enum(MANUAL_MOVEMENT_TYPES).optional(),
  }),
};

// Fecha de vencimiento opcional: ISO con offset, YYYY-MM-DD, o null para limpiar.
const expiryDateField = z
  .union([z.string().datetime({ offset: true }), z.string().date(), z.null()])
  .optional();

export const receiveStockSchema = {
  body: z.object({
    supplier: z.string().trim().max(120).optional(),
    doc_ref: z.string().trim().max(120).optional(),
    // Vencimiento a nivel cabecera (aplica a los ítems sin uno propio).
    expiry_date: expiryDateField,
    items: z
      .array(
        z.object({
          product_id: objectId,
          qty: z.coerce.number().int().positive("qty debe ser un entero > 0"),
          // Costo de compra por UNIDAD (opcional) → actualiza el costo promedio ponderado.
          unit_cost: z.coerce.number().min(0).optional(),
          // Vencimiento por ítem (prioridad sobre el de cabecera).
          expiry_date: expiryDateField,
          // Lote del proveedor (opcional); si falta, el servicio autogenera uno.
          lot_code: z.string().trim().max(60).optional(),
          // Putaway: ubicación física asignada al recibir (opcional).
          location: z
            .object({
              zone: z.string().trim().max(40).optional(),
              rack: z.string().trim().max(40).optional(),
              level: z.string().trim().max(40).optional(),
              code: z.string().trim().max(40).optional(),
            })
            .optional(),
        }),
      )
      .min(1, "Debes recibir al menos un ítem"),
  }),
};

export const lowStockSchema = {
  query: z.object({
    threshold: z.coerce.number().int().min(0).max(100000).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
};

export const expiringSoonSchema = {
  query: z.object({
    days: z.coerce.number().int().min(1).max(365).optional(),
  }),
};

export const barcodeParamSchema = {
  params: z.object({
    code: z.string().min(3).max(64),
  }),
};
