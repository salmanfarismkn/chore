import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Auth0LoginFlowError,
  type Auth0AuthorizationCodeFlow,
} from "./auth0-authorization-code-flow";
import { registerAuthRoutes } from "./auth.routes";
import type { RateLimitCounter } from "../../config/rate-limit";

const authorizationUrl =
  "https://pronto-test.us.auth0.com/authorize?response_type=code";
const testRateLimitCounter: RateLimitCounter = async () => ({
  count: 1,
  ttlMs: 60_000,
});
const joinedCookies = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join("; ") : (value ?? "");

describe("Auth0 authorization-code HTTP boundary", () => {
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  const buildTestApp = async (
    flow: Pick<Auth0AuthorizationCodeFlow, "start" | "complete">,
    logs: string[],
  ) => {
    app = Fastify({
      logger: {
        level: "trace",
        stream: { write: (message: string) => logs.push(message) },
      },
    });
    app.decorate("authenticate", async () => {});
    await app.register(cookie);
    await app.register(registerAuthRoutes, {
      prefix: "/v1/auth",
      flow,
      rateLimitCounter: testRateLimitCounter,
    });
    await app.ready();
    return app;
  };

  it("only starts registered client transactions and returns the authorization URL", async () => {
    const logs: string[] = [];
    const flow = {
      start: vi.fn(async () => ({
        authorizationUrl,
        expiresAt: "2026-11-06T10:00:00.000Z",
        nativeContextBinding: "N".repeat(43),
      })),
      complete: vi.fn(),
    };
    const server = await buildTestApp(flow, logs);

    const invalid = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/transactions",
      payload: { clientType: "admin", redirectUri: "https://evil.test" },
    });
    const valid = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/transactions",
      payload: { clientType: "native", redirectUri: "com.example.app://auth" },
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({
      authorizationUrl,
      expiresAt: "2026-11-06T10:00:00.000Z",
      transactionBinding: "N".repeat(43),
    });
    expect(valid.headers["cache-control"]).toBe("no-store");
    expect(flow.start).toHaveBeenCalledOnce();
    expect(flow.start).toHaveBeenCalledWith("native", "com.example.app://auth");
  });

  it("rejects malformed, oversized, and invalid callback responses generically", async () => {
    const logs: string[] = [];
    const flow = {
      start: vi.fn(),
      complete: vi.fn(async () => {
        throw new Auth0LoginFlowError("invalid_transaction");
      }),
    };
    const server = await buildTestApp(flow, logs);

    const missingState = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/callback",
      payload: { code: "authorization-code" },
    });
    const providerError = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/callback",
      payload: {
        state: "valid-state-123456",
        error: "access_denied",
        contextBinding: "N".repeat(43),
      },
    });
    const oversized = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/callback",
      payload: {
        state: "valid-state-123456",
        code: "x".repeat(9000),
      },
    });

    expect(missingState.statusCode).toBe(400);
    expect(missingState.json()).toEqual({ error: "authentication_failed" });
    expect(providerError.statusCode).toBe(401);
    expect(providerError.json()).toEqual({ error: "authentication_failed" });
    expect(oversized.statusCode).toBe(413);
    expect(JSON.stringify(providerError.json())).not.toContain("access_denied");
  });

  it("returns no provider tokens or local authorization claims and does not log secrets", async () => {
    const logs: string[] = [];
    const flow = {
      start: vi.fn(),
      complete: vi.fn(async () => ({
        status: "authenticated" as const,
        clientType: "native" as const,
        credential: "opaque-native-session-secret",
        csrfToken: null,
        expiresAt: new Date("2026-11-06T09:00:00.000Z"),
      })),
    };
    const server = await buildTestApp(flow, logs);
    const code = "secret-authorization-code-fixture";
    const state = "secret-state-fixture-1234567890";

    const response = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/callback",
      payload: { state, code, contextBinding: "N".repeat(43) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "authenticated",
      sessionToken: "opaque-native-session-secret",
      expiresAt: "2026-11-06T09:00:00.000Z",
    });
    expect(response.body).not.toContain(code);
    expect(response.body).not.toContain("access_token");
    expect(response.body).not.toContain("refresh_token");
    expect(response.headers["cache-control"]).toBe("no-store");
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs.join("")).not.toContain(code);
    expect(logs.join("")).not.toContain(state);
  });

  it("binds web login to its HttpOnly context cookie and returns only a session cookie", async () => {
    const logs: string[] = [];
    const state = "web-context-state-1234567890";
    const contextBinding = "web-context-binding-secret";
    const flow = {
      start: vi.fn(async () => ({
        authorizationUrl: `${authorizationUrl}&state=${state}`,
        expiresAt: "2026-11-06T09:10:00.000Z",
        loginContextCookie: contextBinding,
      })),
      complete: vi.fn(async () => ({
        status: "authenticated" as const,
        clientType: "web" as const,
        credential: "opaque-web-session-secret",
        csrfToken: "one-time-csrf-token",
        expiresAt: new Date("2026-11-06T09:00:00.000Z"),
      })),
    };
    const server = await buildTestApp(flow, logs);
    const started = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/transactions",
      headers: { origin: "http://localhost:5173" },
      payload: {
        clientType: "web",
        redirectUri: "https://web.example.test/auth/callback",
      },
    });

    expect(started.statusCode).toBe(200);
    expect(started.body).not.toContain(contextBinding);
    const loginCookie = joinedCookies(started.headers["set-cookie"]);
    expect(loginCookie).toContain("__Secure-oidc_");
    expect(loginCookie).toContain("HttpOnly");
    expect(loginCookie).toContain("Secure");
    expect(loginCookie).toContain("SameSite=None");
    expect(loginCookie).toContain("Path=/v1/auth/oidc");
    const cookiePair = String(loginCookie).split(";")[0]!;

    const callback = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/callback",
      headers: {
        origin: "http://localhost:5173",
        cookie: cookiePair,
      },
      payload: { state, code: "authorization-code" },
    });

    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({
      status: "authenticated",
      csrfToken: "one-time-csrf-token",
      expiresAt: "2026-11-06T09:00:00.000Z",
    });
    expect(callback.body).not.toContain("opaque-web-session-secret");
    const callbackCookies = joinedCookies(callback.headers["set-cookie"]);
    expect(callbackCookies).toContain("__Secure-pronto_session=");
    expect(callbackCookies).toContain("HttpOnly");
    expect(callbackCookies).toContain("Secure");
    expect(callbackCookies).toContain("SameSite=None");
    expect(callbackCookies).toContain("Path=/v1");
    expect(flow.complete).toHaveBeenCalledWith({
      state,
      code: "authorization-code",
      error: undefined,
      contextBinding,
    });
  });

  it("rejects web callback injection without the matching transaction cookie", async () => {
    const logs: string[] = [];
    const flow = {
      start: vi.fn(),
      complete: vi.fn(),
    };
    const server = await buildTestApp(flow, logs);
    const response = await server.inject({
      method: "POST",
      url: "/v1/auth/oidc/callback",
      headers: { origin: "http://localhost:5173" },
      payload: {
        state: "web-context-state-1234567890",
        code: "authorization-code",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication_failed" });
    expect(flow.complete).not.toHaveBeenCalled();
  });
});
