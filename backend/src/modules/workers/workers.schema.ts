import { z } from "zod";

export const createWorkerSchema = z.object({
  userId: z.number().int().positive(),
  bio: z.string().min(10).max(500),
});

export type CreateWorkerSchema = z.infer<typeof createWorkerSchema>;