import {
  pgTable,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
  serial,
  uniqueIndex,
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
    // enforce uniqueness of workerId + serviceCategoryId
    workerServiceUnique: uniqueIndex("worker_service_unique")
      .on(table.workerId, table.serviceCategoryId),

    workerIdx: index("worker_services_worker_idx").on(table.workerId),

    serviceIdx: index("worker_services_service_idx").on(table.serviceCategoryId),
  })
);
