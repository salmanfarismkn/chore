import { pgTable, serial, varchar, text, numeric, integer, timestamp, boolean, check} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm"; 

export const service_categories = pgTable(
  "service_categories",
  {
    id: serial("id").primaryKey(),

    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),

    base_price: numeric("base_price", { precision: 10, scale: 2 }).notNull(),
    estimated_duration_minutes: integer("estimated_duration_minutes").notNull(),

    is_active: boolean("is_active").default(true).notNull(),

    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    basePriceCheck: check(
      "service_categories_base_price_check",
      sql`${table.base_price} >= 0`
    ),
    durationMinutesCheck: check(
      "service_categories_duration_minutes_check",
      sql`${table.estimated_duration_minutes} > 0`
    ),
  })
);

