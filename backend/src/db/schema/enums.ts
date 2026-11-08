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

export const workerApprovalStatusEnum = pgEnum("worker_approval_status", [
  "pending",
  "approved",
  "rejected",
]);

// Booking status
export const bookingStatusEnum = pgEnum("booking_status", [
  "PENDING",
  "ALLOCATING",
  "ASSIGNED",
  "ACCEPTED",
  "EN_ROUTE",
  "WORKING",
  "COMPLETED",
  "CANCELLED",
  "ALLOCATION_FAILED",
]);
