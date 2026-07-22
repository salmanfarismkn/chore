import { pgTable, integer, text, real, timestamp, index, check, serial } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";   
import { workerStatusEnum } from "./enums";

export const workerProfiles = pgTable(
  "worker_profiles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().unique(),

    bio: text("bio"),

    averageRating: real("average_rating").default(0),
    completedJobs: integer("completed_jobs").default(0),


    status: workerStatusEnum("status")
    .default("offline")
    .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true,}),
  },
  (table) => ({
    statusIdx: index("worker_profiles_status_idx").on(table.status),
    ratingCheck: check(
      "worker_profiles_rating_check",
      sql`${table.averageRating} >= 0 AND ${table.averageRating} <= 5`
    ),
    jobsCheck: check(
      "worker_profiles_jobs_check",
      sql`${table.completedJobs} >= 0`
    ),
  })
);
