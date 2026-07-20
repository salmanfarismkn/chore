import {
  pgTable,
  serial,
  varchar,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";

import { userRoleEnum } from "./enums";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),

  phoneNumber: varchar("phone_number", { length: 20 })
    .notNull()
    .unique(),

  fullName: varchar("full_name", { length: 100 })
    .notNull(),

  email: varchar("email", { length: 255 }),

  role: userRoleEnum("role").notNull(),

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
});