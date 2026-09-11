import { execSync } from "node:child_process";
import postgres from "postgres";

const ensureTestSchema = async () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Vitest setup");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const existing = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'service_categories', 'worker_profiles', 'bookings', 'idempotency_keys')
    `;

    if (existing.length >= 5) {
      return;
    }

    console.log("Initializing PostgreSQL schema for Vitest...");

    execSync("pnpm exec drizzle-kit push --config drizzle.config.ts --force", {
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "1",
      },
    });
  } finally {
    await sql.end();
  }
};

void ensureTestSchema();
