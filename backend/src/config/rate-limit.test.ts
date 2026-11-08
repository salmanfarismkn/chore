import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDistributedRateLimitPreHandler,
  ipRateLimitIdentity,
  RATE_LIMIT_POLICIES,
  rateLimitKey,
  registerDistributedRateLimits,
  userRateLimitIdentity,
  type RateLimitCounter,
  type RateLimitPolicy,
} from "./rate-limit";

const policy: RateLimitPolicy = {
  name: "test-policy",
  max: 2,
  windowMs: 60_000,
};

const apps: ReturnType<typeof Fastify>[] = [];

const createApp = () => {
  const app = Fastify();
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("distributed rate-limit policies", () => {
  it("allows exactly the configured limit and returns a bounded Retry-After", async () => {
    let count = 0;
    const counter: RateLimitCounter = async () => ({
      count: ++count,
      ttlMs: 2_100,
    });
    const app = createApp();
    app.post(
      "/v1/limited",
      {
        preHandler: [
          createDistributedRateLimitPreHandler(
            policy,
            () => "ip:127.0.0.1",
            counter,
          ),
        ],
      },
      async () => ({ ok: true }),
    );
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
    expect(limited.headers["retry-after"]).toBe("3");
    expect(limited.json()).toEqual({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded",
    });
    expect(limited.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("fails closed without leaking Redis errors and leaves health routes unthrottled", async () => {
    const counter: RateLimitCounter = async () => {
      throw new Error("sensitive Redis connection details");
    };
    const app = createApp();
    registerDistributedRateLimits(app, counter);
    app.get("/v1/records/:id", async () => ({ ok: true }));
    app.get("/health", async () => ({ ok: true }));
    app.get("/ready", async () => ({ ok: true }));
    await app.ready();

    const unavailable = await app.inject({
      method: "GET",
      url: "/v1/records/123",
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("sensitive Redis");
    expect(unavailable.json()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Request protection is temporarily unavailable",
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/ready" })).statusCode,
    ).toBe(200);
  });

  it("fails closed for authentication and authenticated mutation policies", async () => {
    const counter: RateLimitCounter = async () => {
      throw new Error("private Redis endpoint");
    };
    const app = createApp();
    app.post(
      "/v1/auth/callback",
      {
        preHandler: [
          createDistributedRateLimitPreHandler(
            RATE_LIMIT_POLICIES.authorizationCallback,
            (request) => ipRateLimitIdentity(request.ip),
            counter,
          ),
        ],
      },
      async () => ({ ok: true }),
    );
    app.post(
      "/v1/bookings",
      {
        preHandler: [
          async (request) => {
            request.user = { userId: 7, role: "customer" };
          },
          createDistributedRateLimitPreHandler(
            RATE_LIMIT_POLICIES.bookingCreation,
            (request) => userRateLimitIdentity(request.user?.userId),
            counter,
          ),
        ],
      },
      async () => ({ ok: true }),
    );
    await app.ready();

    const authFailure = await app.inject({
      method: "POST",
      url: "/v1/auth/callback",
    });
    const bookingFailure = await app.inject({
      method: "POST",
      url: "/v1/bookings",
    });
    expect(authFailure.statusCode).toBe(503);
    expect(bookingFailure.statusCode).toBe(503);
    expect(authFailure.body).not.toContain("private Redis");
    expect(bookingFailure.body).not.toContain("private Redis");
  });

  it("ignores forwarded IP headers unless Fastify is configured to trust the proxy", async () => {
    const keys: string[] = [];
    const counter: RateLimitCounter = async (key) => {
      keys.push(key);
      return { count: 1, ttlMs: 1_000 };
    };
    const app = createApp();
    registerDistributedRateLimits(app, counter);
    app.get("/v1/items/:id", async () => ({ ok: true }));
    await app.ready();

    await app.inject({
      url: "/v1/items/first",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    await app.inject({
      url: "/v1/items/second",
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("uses forwarded client IPs when the peer is explicitly trusted by Fastify", async () => {
    const keys: string[] = [];
    const counter: RateLimitCounter = async (key) => {
      keys.push(key);
      return { count: 1, ttlMs: 1_000 };
    };
    const app = Fastify({ trustProxy: "127.0.0.1" });
    apps.push(app);
    registerDistributedRateLimits(app, counter);
    app.get("/v1/items/:id", async () => ({ ok: true }));
    await app.ready();

    await app.inject({
      url: "/v1/items/first",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    await app.inject({
      url: "/v1/items/second",
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("isolates authenticated users, IPs, and fixed-size hashed identifiers", () => {
    const userA = userRateLimitIdentity(41);
    const userB = userRateLimitIdentity(42);
    const ipA = ipRateLimitIdentity("192.0.2.10");
    const ipB = ipRateLimitIdentity("192.0.2.11");

    expect(userA).not.toBe(userB);
    expect(ipA).not.toBe(ipB);
    expect(rateLimitKey(policy, userA!)).not.toBe(rateLimitKey(policy, userB!));
    expect(rateLimitKey(policy, userA!)).not.toBe(rateLimitKey(policy, ipA!));

    const longAttackerInput = "x".repeat(10_000);
    const key = rateLimitKey(policy, longAttackerInput);
    expect(key.length).toBeLessThan(100);
    expect(key).not.toContain(longAttackerInput);
    expect(userRateLimitIdentity(0)).toBeNull();
    expect(ipRateLimitIdentity("not-an-ip")).toBeNull();
    expect(
      rateLimitKey(RATE_LIMIT_POLICIES.loginInitiation, "ip:192.0.2.1"),
    ).not.toBe(
      rateLimitKey(RATE_LIMIT_POLICIES.authorizationCallback, "ip:192.0.2.1"),
    );
  });
});
