import {
  pgTable,
  integer,
  text,
  real,
  timestamp,
  index,
  check,
  serial,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workerApprovalStatusEnum, workerStatusEnum } from "./enums";
import { users } from "./users";

export const workerProfiles = pgTable(
  "worker_profiles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().unique(),

    bio: text("bio"),

    averageRating: real("average_rating").default(0),
    completedJobs: integer("completed_jobs").default(0),
    latitude: real("latitude"),
    longitude: real("longitude"),

    status: workerStatusEnum("status")
      .default("offline")
      .notNull(),
    approvalStatus: workerApprovalStatusEnum("approval_status")
      .default("pending")
      .notNull(),
    approvalDecidedBy: integer("approval_decided_by").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    approvalDecidedAt: timestamp("approval_decided_at", {
      withTimezone: true,
    }),

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
    approvalStatusIdx: index("worker_profiles_approval_status_idx").on(
      table.approvalStatus,
    ),
    approvalDecisionCheck: check(
      "worker_profiles_approval_decision_check",
      sql`(${table.approvalStatus} = 'pending' AND ${table.approvalDecidedBy} IS NULL AND ${table.approvalDecidedAt} IS NULL) OR (${table.approvalStatus} <> 'pending' AND ${table.approvalDecidedAt} IS NOT NULL)`,
    ),
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
