import { pgEnum } from "drizzle-orm/pg-core";

// User roles
export const userRoleEnum = pgEnum("user_role", [
  "customer",
  "worker",
  "admin",
]);

// Worker status
export const workerStatusEnum = pgEnum("worker_status", [
  "offline",
  "available",
  "busy",
  "suspended",
]);

// Booking status
export const bookingStatusEnum = pgEnum("booking_status", [
  "pending",
  "accepted",
  "en_route",
  "working",
  "completed",
  "cancelled",
]);
