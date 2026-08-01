import { z } from "zod";
import mongoose from "mongoose";
import { isValidRut } from "../utils/rut.js";
import { ROLES } from "../utils/constants.js";

const objectIdSchema = z
  .string({ required_error: "ID requerido" })
  .refine((v) => mongoose.Types.ObjectId.isValid(v), { message: "ID inválido" });

const rutSchema = z
  .string()
  .trim()
  .max(15)
  .refine((v) => !v || isValidRut(v), { message: "RUT inválido" })
  .optional()
  .nullable();

const bankInfoSchema = z
  .object({
    bank: z.string().trim().max(100).optional().nullable(),
    account_type: z.string().trim().max(50).optional().nullable(),
    account_number: z.string().trim().max(50).optional().nullable(),
    holder_name: z.string().trim().max(200).optional().nullable(),
    holder_rut: rutSchema,
  })
  .partial()
  .optional();

export const registerVendorSchema = z.object({
  name: z.string().trim().min(2).max(200),
  rut: rutSchema,
  description: z.string().trim().max(2000).optional(),
  logo_url: z.string().trim().url().optional().nullable(),
  banner_url: z.string().trim().url().optional().nullable(),
  commune: z.string().trim().max(100).optional().nullable(),
  region: z.string().trim().max(100).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  bank_info: bankInfoSchema,
});

export const updateMyVendorSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    logo_url: z.string().trim().url().optional().nullable(),
    banner_url: z.string().trim().url().optional().nullable(),
    commune: z.string().trim().max(100).optional().nullable(),
    region: z.string().trim().max(100).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable(),
    bank_info: bankInfoSchema,
  })
  .strict("Campo no permitido");

export const adminUpdateVendorSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    rut: rutSchema,
    description: z.string().trim().max(2000).optional(),
    logo_url: z.string().trim().url().optional().nullable(),
    banner_url: z.string().trim().url().optional().nullable(),
    commune: z.string().trim().max(100).optional().nullable(),
    region: z.string().trim().max(100).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable(),
    is_active: z.boolean().optional(),
    is_verified: z.boolean().optional(),
    commission_rate: z.number().min(0).max(1).optional(),
    bank_info: bankInfoSchema,
  })
  .strict("Campo no permitido");

export const listVendorsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  commune: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().min(1).max(100).optional(),
  is_active: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  is_verified: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
});

export const vendorIdParamSchema = z.object({ id: objectIdSchema });
export { ROLES };
