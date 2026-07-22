import {
  pgTable,
  integer,
  numeric,
  boolean,
  primaryKey,
  timestamp,
  index,
  serial,
} from "drizzle-orm/pg-core";

export const workerServices = pgTable(
  "worker_services",
  {
  id: serial("id").primaryKey(),

  workerId: integer("worker_id").notNull(),

  serviceCategoryId: integer("service_category_id").notNull(),

  price: numeric("price", {
    precision: 10,
    scale: 2,
  }).notNull(),

  isActive: boolean("is_active")
    .default(true)
    .notNull(),

  createdAt: timestamp("created_at", {
    withTimezone: true,
  })
    .defaultNow()
    .notNull(),

  updatedAt: timestamp("updated_at", {
    withTimezone: true,
  })
    .defaultNow()
    .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.workerId,
        table.serviceCategoryId,
      ],
    }),

    workerIdx: index(
      "worker_services_worker_idx"
    ).on(table.workerId),

    serviceIdx: index(
      "worker_services_service_idx"
    ).on(table.serviceCategoryId),
  })
);
