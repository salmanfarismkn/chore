import { z } from "zod";

export const createUserSchema = z.object({
  phoneNumber: z.string().min(10).max(15),
  fullName: z.string().min(2).max(100),
  role: z.enum(["customer", "worker"]),
});

export type CreateUserSchema = z.infer<typeof createUserSchema>;