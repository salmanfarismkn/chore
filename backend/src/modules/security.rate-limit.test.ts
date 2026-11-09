import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import {
  createDistributedRateLimitPreHandler,
  type RateLimitCounter,
} from "../config/rate-limit";

const app = Fastify();

describe("Route-scoped distributed rate limits", () => {
  it("returns 429 at the configured boundary without limiting unrelated routes", async () => {
    let count = 0;
    const counter: RateLimitCounter = async () => ({
      count: ++count,
      ttlMs: 60_000,
    });
    app.post(
      "/v1/limited",
      {
        preHandler: [
          createDistributedRateLimitPreHandler(
            { name: "route-test", max: 2, windowMs: 60_000 },
            () => "user:42",
            counter,
          ),
        ],
      },
      async () => ({ ok: true }),
    );
    app.get("/unlimited", async () => ({ ok: true }));
    await app.ready();

    expect(
      (await app.inject({ method: "POST", url: "/v1/limited" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/v1/limited" })).statusCode,
    ).toBe(200);
    const limited = await app.inject({
      method: "POST",
      url: "/v1/limited",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toHaveProperty("statusCode", 429);

    expect((await app.inject({ method: "GET", url: "/unlimited" })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });
});
