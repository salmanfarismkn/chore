import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, describe, expect, it } from "vitest";

const app = Fastify();

describe("Explicit route rate limits", () => {
  it("returns the standard 429 response and does not globally limit other routes", async () => {
    await app.register(rateLimit, { global: false });
    app.post("/limited", {
      config: { rateLimit: { max: 2, timeWindow: 60_000 } },
    }, async () => ({ ok: true }));
    app.get("/unlimited", async () => ({ ok: true }));
    await app.ready();

    expect((await app.inject({ method: "POST", url: "/limited" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/limited" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/limited" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toHaveProperty("statusCode", 429);

    expect((await app.inject({ method: "GET", url: "/unlimited" })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });
});
