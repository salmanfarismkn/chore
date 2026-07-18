import { pgTable, integer, text, real, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";   
import { workerStatusEnum } from "./enums";

export const workerProfiles = pgTable(
  "worker_profiles",
  {
    user_id: integer("user_id").primaryKey().notNull(),

    bio: text("bio"),

    average_rating: real("average_rating").default(0).notNull(),
    completed_jobs: integer("completed_jobs").default(0).notNull(),

    status: workerStatusEnum("status").notNull(),

    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    statusIdx: index("worker_profiles_status_idx").on(table.status),
    ratingCheck: check(
      "worker_profiles_rating_check",
      sql`${table.average_rating} >= 0 AND ${table.average_rating} <= 5`
    ),
    jobsCheck: check(
      "worker_profiles_jobs_check",
      sql`${table.completed_jobs} >= 0`
    ),
  })
);
