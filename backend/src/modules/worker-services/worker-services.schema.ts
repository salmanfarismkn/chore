import { z } from "zod";

export const createWorkerServiceSchema = z.object({
  workerId: z.number().int().positive(),

  serviceCategoryId: z.number().int().positive(),

  price: z.number().positive(),
});