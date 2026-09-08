import {
  pgTable,
  serial,
  integer,
  varchar,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: serial("id").primaryKey(),

    userId: integer("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),

    key: varchar("key", {
      length: 255,
    }).notNull(),

    response: jsonb("response").notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },

  (table) => ({
    userKeyUnique: unique(
      "idempotency_keys_user_id_key_unique"
    ).on(table.userId, table.key),
  })
);