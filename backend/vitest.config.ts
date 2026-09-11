// vitest.config.ts
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

process.env.NODE_ENV = "test";

dotenv.config({ path: ".env.test", override: true });

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
