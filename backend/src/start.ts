import { execSync } from "node:child_process";

execSync("pnpm drizzle-kit migrate", {
  stdio: "inherit",
});

void import("./server.js");