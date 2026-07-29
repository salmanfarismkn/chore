import { z } from "zod";

export const createBookingSchema = z.object({
  customerId: z.number().int().positive(),
  serviceCategoryId: z.number().int().positive(),
  scheduledAt: z.coerce.date(), 
});
