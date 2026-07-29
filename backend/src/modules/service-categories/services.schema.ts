import { z } from "zod";

export const createServiceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "Service name is required")
    .max(100),

  description: z
    .string()
    .trim()
    .max(500)
    .optional(),

  basePrice: z
    .number()
    .positive("Base price must be greater than 0"),

  estimatedDurationMinutes: z
    .number()
    .int()
    .positive("Duration must be greater than 0"),
});

export type CreateServiceSchema = z.infer<
  typeof createServiceSchema
>;