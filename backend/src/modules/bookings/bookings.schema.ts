import { z } from "zod";

export const createBookingSchema = z.object({
  customerId: z.number().int().positive(),
  serviceCategoryId: z.number().int().positive(),
  scheduledAt: z.coerce.date(), 
  pickupLatitude: z.number().min(-90).max(90),
  pickupLongitude: z.number().min(-180).max(180),
});
