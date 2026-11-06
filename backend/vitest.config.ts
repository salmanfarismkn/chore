// vitest.config.ts
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

process.env.NODE_ENV = "test";

dotenv.config({ path: ".env.test" });

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/pronto";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.JWT_SECRET ??= "test-only-secret-that-is-long-enough-123456";
process.env.CORS_ORIGIN ??= "*";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
