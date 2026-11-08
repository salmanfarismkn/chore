import { execSync } from "node:child_process";
import postgres from "postgres";
import { env } from "./config/env";

const MIGRATION_LOCK_NAMESPACE = 17_103;
const MIGRATION_LOCK_ID = 10;

const start = async () => {
  const migrationLock = postgres(env.DATABASE_URL, { max: 1 });
  try {
    await migrationLock`SELECT pg_advisory_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})`;
    execSync("pnpm drizzle-kit migrate", {
      stdio: "inherit",
    });
  } finally {
    await migrationLock.end();
  }

  void import("./server.js");
};

void start().catch((error: unknown) => {
  console.error("Database migration failed; backend startup aborted");
  console.error(error);
  process.exitCode = 1;
});
