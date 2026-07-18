import { pgTable, serial, varchar, timestamp, boolean } from "drizzle-orm/pg-core";
import { userRoleEnum } from "./enums";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),

  phone: varchar("phone_number", { length: 20 }).notNull().unique(),
  name: varchar("full_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),

  role: userRoleEnum("role").notNull(),

  is_active: boolean("is_active").default(true).notNull(),

  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
