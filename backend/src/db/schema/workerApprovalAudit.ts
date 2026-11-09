import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { workerApprovalStatusEnum } from "./enums";

export const workerApprovalAuditEvents = pgTable(
  "worker_approval_audit_events",
  {
    id: serial("id").primaryKey(),
    workerProfileId: integer("worker_profile_id").notNull(),
    previousStatus: workerApprovalStatusEnum("previous_status").notNull(),
    newStatus: workerApprovalStatusEnum("new_status").notNull(),
    actorUserId: integer("actor_user_id").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reason: varchar("reason", { length: 500 }),
  },
  (table) => ({
    workerTimelineIdx: index("worker_approval_audit_worker_time_idx").on(
      table.workerProfileId,
      table.decidedAt,
    ),
    actorTimelineIdx: index("worker_approval_audit_actor_time_idx").on(
      table.actorUserId,
      table.decidedAt,
    ),
    transitionCheck: check(
      "worker_approval_audit_transition_check",
      sql`${table.previousStatus} <> ${table.newStatus} AND ${table.newStatus} <> 'pending'`,
    ),
  }),
);
