import {
  pgTable,
  serial,
  integer,
  numeric,
  varchar,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { bookingStatusEnum } from "./enums";

export const bookings = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),

    customerId: integer("customer_id").notNull(),

    workerId: integer("worker_id"), // nullable

    serviceCategoryId: integer("service_category_id").notNull(),

    status: bookingStatusEnum("status").notNull(),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    estimatedPrice: numeric("estimated_price", {
      precision: 10,
      scale: 2,
    }),

    finalPrice: numeric("final_price", {
      precision: 10,
      scale: 2,
    }),

    otp: varchar("otp", { length: 10 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    customerIdx: index("bookings_customer_id_idx").on(table.customerId),
    workerIdx: index("bookings_worker_id_idx").on(table.workerId),
    statusIdx: index("bookings_status_idx").on(table.status),
    scheduledAtIdx: index("bookings_scheduled_at_idx").on(table.scheduledAt),
    serviceCategoryIdx: index("bookings_service_category_id_idx").on(table.serviceCategoryId),
  })
);

