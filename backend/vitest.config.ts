// vitest.config.ts
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

process.env.NODE_ENV = "test";

dotenv.config({ path: ".env.test" });

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/pronto";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.CORS_ORIGIN ??= "http://localhost:5173";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
