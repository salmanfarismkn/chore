import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisAuth0LoginTransactionStore } from "./auth0-login-transaction";

const testRedisUrl = process.env.OIDC_TEST_REDIS_URL;
const redisDescribe = testRedisUrl ? describe : describe.skip;
const client = testRedisUrl ? createClient({ url: testRedisUrl }) : undefined;

redisDescribe("Redis-backed OIDC login transactions", () => {
  beforeAll(async () => {
    await client!.connect();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
  });

  it("allows exactly one of concurrent consumers to take a transaction", async () => {
    const store = new RedisAuth0LoginTransactionStore(client!);
    const state = `integration-${randomUUID()}`;
    const stateKey = `auth0:oidc:transactions:${createHash("sha256")
      .update(state)
      .digest("base64url")}`;
    const transaction = {
      clientType: "native" as const,
      clientId: "native-test-client",
      redirectUri: "com.example.prontoplus://auth/callback",
      codeVerifier: randomUUID().replaceAll("-", "").repeat(2),
      nonce: randomUUID(),
      contextHash: createHash("sha256").update(randomUUID()).digest("hex"),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    await store.save(state, transaction);
    const ttl = await client!.ttl(stateKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    const consumed = await Promise.all([
      store.consume(state),
      store.consume(state),
      store.consume(state),
    ]);

    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(consumed.filter(Boolean)[0]).toEqual(transaction);
    expect(await client!.ttl(stateKey)).toBe(-2);
    await expect(store.consume(state)).resolves.toBeNull();
  });
});
