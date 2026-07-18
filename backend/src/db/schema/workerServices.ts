import { pgTable, integer, primaryKey, boolean, index } from "drizzle-orm/pg-core";

export const workerServices = pgTable(
  "worker_services",
  {
    worker_id: integer("worker_id").notNull(),
    service_category_id: integer("service_category_id").notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.worker_id, table.service_category_id] }),
    workerServiceIdx: index("worker_services_worker_category_idx").on(
      table.worker_id,
      table.service_category_id
    ),
  })
);
