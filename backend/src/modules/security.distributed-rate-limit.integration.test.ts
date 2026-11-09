import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDistributedRateLimitPreHandler,
  createRedisRateLimitCounter,
  rateLimitKey,
  type RateLimitPolicy,
} from "../config/rate-limit";

const enabled = process.env.RUN_RATE_LIMIT_REDIS_INTEGRATION === "1";
const integration = enabled ? describe : describe.skip;
const redisUrl = process.env.RATE_LIMIT_TEST_REDIS_URL;

let clients: RedisClientType[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
const keys = new Set<string>();
const clientErrors: Error[] = [];

const createPolicy = (max: number, windowMs: number): RateLimitPolicy => ({
  name: `it-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  max,
  windowMs,
});

const createApp = (
  client: RedisClientType,
  policy: RateLimitPolicy,
  identity: string,
) => {
  const counter = createRedisRateLimitCounter(
    (script, key, windowMs) =>
      client.eval(script, {
        keys: [key],
        arguments: [String(windowMs)],
      }),
    () => client.isReady,
  );
  const app = Fastify();
  apps.push(app);
  app.post(
    "/v1/resource",
    {
      preHandler: [
        createDistributedRateLimitPreHandler(policy, () => identity, counter),
      ],
    },
    async () => ({ ok: true }),
  );
  return app;
};

integration("Redis-backed distributed rate limits", () => {
  beforeAll(async () => {
    if (!redisUrl) {
      throw new Error("RATE_LIMIT_TEST_REDIS_URL is required for this suite");
    }
    const host = new URL(redisUrl).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error(
        "Rate-limit integration tests require disposable local Redis",
      );
    }
    clients = [
      createClient({ url: redisUrl }),
      createClient({ url: redisUrl }),
    ];
    clients.forEach((client) =>
      client.on("error", (error) => clientErrors.push(error)),
    );
    await Promise.all(clients.map((client) => client.connect()));
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (clients.length > 0) {
      await Promise.all([...keys].map((key) => clients[0]!.del(key)));
      await Promise.all(
        clients.map(async (client) => {
          if (client.isOpen) await client.quit();
        }),
      );
    }
    expect(clientErrors).toEqual([]);
  });

  it("shares atomic counters across independently constructed app instances", async () => {
    const policy = createPolicy(8, 60_000);
    const identity = `user:${randomUUID()}`;
    keys.add(rateLimitKey(policy, identity));
    const appsByInstance = clients.map((client) =>
      createApp(client, policy, identity),
    );
    await Promise.all(appsByInstance.map((app) => app.ready()));

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        appsByInstance[index % appsByInstance.length]!.inject({
          method: "POST",
          url: "/v1/resource",
        }),
      ),
    );

    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(
      8,
    );
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(
      32,
    );
  });

  it("expires fixed windows and reports Retry-After for the current TTL", async () => {
    const policy = createPolicy(1, 500);
    const identity = `ip:${randomUUID()}`;
    keys.add(rateLimitKey(policy, identity));
    const first = createApp(clients[0]!, policy, identity);
    const second = createApp(clients[1]!, policy, identity);
    await Promise.all([first.ready(), second.ready()]);

    expect(
      (await first.inject({ method: "POST", url: "/v1/resource" })).statusCode,
    ).toBe(200);
    const limited = await second.inject({
      method: "POST",
      url: "/v1/resource",
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      (await second.inject({ method: "POST", url: "/v1/resource" })).statusCode,
    ).toBe(200);
  });

  it("keeps authenticated-user buckets separate", async () => {
    const policy = createPolicy(1, 60_000);
    const appA = createApp(clients[0]!, policy, "user:1001");
    const appB = createApp(clients[1]!, policy, "user:1002");
    await Promise.all([appA.ready(), appB.ready()]);
    keys.add(rateLimitKey(policy, "user:1001"));
    keys.add(rateLimitKey(policy, "user:1002"));

    expect(
      (await appA.inject({ method: "POST", url: "/v1/resource" })).statusCode,
    ).toBe(200);
    expect(
      (await appB.inject({ method: "POST", url: "/v1/resource" })).statusCode,
    ).toBe(200);
    expect(
      (await appA.inject({ method: "POST", url: "/v1/resource" })).statusCode,
    ).toBe(429);
  });
});
