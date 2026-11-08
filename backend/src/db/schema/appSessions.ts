import {
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const appSessionClientTypeEnum = pgEnum("app_session_client_type", [
  "web",
  "native",
]);

export const appSessions = pgTable(
  "app_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientType: appSessionClientTypeEnum("client_type").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    csrfTokenHash: varchar("csrf_token_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("app_sessions_token_hash_unique").on(
      table.tokenHash,
    ),
    userIdIdx: index("app_sessions_user_id_idx").on(table.userId),
    expiresAtIdx: index("app_sessions_expires_at_idx").on(table.expiresAt),
  }),
);
