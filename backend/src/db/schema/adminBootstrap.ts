import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  smallint,
  timestamp,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const adminBootstrapState = pgTable(
  "admin_bootstrap_state",
  {
    id: smallint("id").primaryKey().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: integer("completed_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    singletonCheck: check(
      "admin_bootstrap_state_singleton_check",
      sql`${table.id} = 1`,
    ),
    completionCheck: check(
      "admin_bootstrap_state_completion_check",
      sql`(${table.completedAt} IS NULL AND ${table.completedBy} IS NULL) OR ${table.completedAt} IS NOT NULL`,
    ),
  }),
);
