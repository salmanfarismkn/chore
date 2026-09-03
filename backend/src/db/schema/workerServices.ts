import {
  pgTable,
  integer,
  boolean,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

import { workerProfiles } from "./workerProfiles";
import { serviceCategories } from "./serviceCategories";

export const workerServices = pgTable(
  "worker_services",
  {
    workerId: integer("worker_id")
      .notNull()
      .references(() => workerProfiles.userId, {
        onDelete: "cascade",
      }),

    serviceCategoryId: integer("service_category_id")
      .notNull()
      .references(() => serviceCategories.id, {
        onDelete: "cascade",
      }),

    isActive: boolean("is_active").default(true).notNull(),

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
    primaryKey: primaryKey({
      columns: [table.workerId, table.serviceCategoryId],
    }),

    workerIdx: index("worker_services_worker_idx").on(
      table.workerId
    ),

    categoryWorkerIdx: index(
      "worker_services_category_worker_idx"
    ).on(
      table.serviceCategoryId,
      table.workerId
    ),
  })
);