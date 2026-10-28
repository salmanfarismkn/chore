import { z } from "zod";

export const createWorkerSchema = z.object({
  userId: z.number().int().positive(),
  bio: z.string().min(10).max(500),
});

const workerStatusSchema = z.enum([
  "offline",
  "available",
  "busy",
  "suspended",
]);

const workerBioSchema = z.string().min(10).max(500).optional();

export const updateWorkerSchema = z
  .object({
    bio: workerBioSchema,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0);

export const adminUpdateWorkerSchema = z
  .object({
    bio: workerBioSchema,
    status: workerStatusSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0);

export type CreateWorkerSchema = z.infer<typeof createWorkerSchema>;
export type UpdateWorkerSchema = z.infer<typeof adminUpdateWorkerSchema>;