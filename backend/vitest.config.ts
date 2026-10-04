// vitest.config.ts
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

process.env.NODE_ENV = "test";

dotenv.config({ path: ".env.test" });

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
