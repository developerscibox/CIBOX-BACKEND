import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "ID inválido");

export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  unread_only: z.union([z.literal("true"), z.literal("false")]).optional(),
});

export const notificationParamsSchema = z.object({
  id: objectIdSchema,
});
