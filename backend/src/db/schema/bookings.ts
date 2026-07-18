import { pgTable, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { bookingStatusEnum } from "./enums";

export const bookings = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),

    customer_id: integer("customer_id").notNull(),
    worker_service_id: integer("worker_service_id").notNull(),

    status: bookingStatusEnum("status").notNull(),

    scheduled_at: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    customerIdx: index("bookings_customer_id_idx").on(table.customer_id),
    statusIdx: index("bookings_status_idx").on(table.status),
    scheduledAtIdx: index("bookings_scheduled_at_idx").on(table.scheduled_at),
  })
);
