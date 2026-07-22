import { pgTable, serial, varchar, text, numeric, integer, timestamp, boolean, check} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm"; 

export const serviceCategories = pgTable(
  "service_categories",
  {
    id: serial("id").primaryKey(),

    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),

    basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(),
    estimatedDurationMinutes: integer("estimated_duration_minutes").notNull(),

    isActive: boolean("is_active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    basePriceCheck: check(
      "service_categories_base_price_check",
      sql`${table.basePrice} >= 0`
    ),
    durationMinutesCheck: check(
      "service_categories_duration_minutes_check",
      sql`${table.estimatedDurationMinutes} > 0`
    ),
  })
);

