import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseEnvironment } from "./env";
import { isTestTokenRouteEnabled } from "../modules/auth/auth.routes";

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://app:strong-password@postgres:5432/pronto",
  REDIS_URL: "redis://:strong-password@redis:6379",
  CORS_ORIGIN: "https://app.example.com",
  TRUST_PROXY: "1",
  AUTH0_ISSUER: "https://pronto-test.us.auth0.com/",
  AUTH0_CLIENT_IDS: "web-client-id,mobile-client-id",
  AUTH0_WEB_CLIENT_ID: "web-client-id",
  AUTH0_NATIVE_CLIENT_ID: "mobile-client-id",
  AUTH0_WEB_REDIRECT_URIS: "https://web.example.test/auth/callback",
  AUTH0_NATIVE_REDIRECT_URIS: "com.example.prontoplus://auth/callback",
};

describe("environment validation", () => {
  it("rejects missing production secrets", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: validProductionEnvironment.DATABASE_URL,
        REDIS_URL: validProductionEnvironment.REDIS_URL,
        CORS_ORIGIN: validProductionEnvironment.CORS_ORIGIN,
      }),
    ).toThrow(ZodError);
  });

  it("rejects local database and Redis endpoints in production", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/pronto",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(ZodError);
  });

  it("requires explicit Auth0 issuer and client IDs in production", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_ISSUER: undefined,
        AUTH0_CLIENT_IDS: undefined,
      }),
    ).toThrow(/AUTH0_ISSUER|AUTH0_CLIENT_IDS/);
  });

  it("rejects wildcard and placeholder Auth0 configuration in production", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_ISSUER: "https://*.auth0.com/",
      }),
    ).toThrow(/AUTH0_ISSUER/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_CLIENT_IDS: "web-client-id,*",
      }),
    ).toThrow(/AUTH0_CLIENT_IDS/);
  });

  it("requires distinct clients and valid, exact callback allowlists", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_NATIVE_CLIENT_ID: "web-client-id",
      }),
    ).toThrow(/Distinct, exact web and native Auth0 client IDs/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_CLIENT_IDS: "web-client-id,another-client-id",
      }),
    ).toThrow(/AUTH0_CLIENT_IDS/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_WEB_REDIRECT_URIS: "http://web.example.test/callback",
      }),
    ).toThrow(/AUTH0_WEB_REDIRECT_URIS/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_NATIVE_REDIRECT_URIS: "com.example.app://auth/*",
      }),
    ).toThrow(/AUTH0_NATIVE_REDIRECT_URIS/);
  });

  it("requires a restricted trusted TLS ingress in production", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        TRUST_PROXY: "false",
      }),
    ).toThrow(/TRUST_PROXY/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        TRUST_PROXY: "true",
      }),
    ).toThrow(/TRUST_PROXY/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        TRUST_PROXY: "00",
      }),
    ).toThrow(/TRUST_PROXY/);
  });

  it("requires exact trusted web origins and a bounded session lifetime", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        CORS_ORIGIN: "https://*.example.com",
      }),
    ).toThrow(/CORS_ORIGIN/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        CORS_ORIGIN: "https://app.example.com/path",
      }),
    ).toThrow(/CORS_ORIGIN/);
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        APP_SESSION_TTL_SECONDS: "120",
      }),
    ).toThrow(ZodError);

    const parsed = parseEnvironment({
      ...validProductionEnvironment,
      CORS_ORIGIN: "https://app.example.com,https://admin.example.com",
      APP_SESSION_TTL_SECONDS: "3600",
    });
    expect(parsed.trustedWebOrigins).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("keeps development defaults compatible", () => {
    const value = parseEnvironment({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/pronto",
    });

    expect(value.REDIS_URL).toBe("redis://localhost:6379");
    expect(value.CORS_ORIGIN).toBe("http://localhost:5173");
    expect(value.AUTH0_ISSUER).toBeUndefined();
    expect(value.AUTH0_CLIENT_IDS).toBeUndefined();
    expect(value.AUTH0_WEB_CLIENT_ID).toBeUndefined();
    expect(value.AUTH0_NATIVE_REDIRECT_URIS).toBeUndefined();
  });

  it("does not include secret values in validation errors", () => {
    const secret = "private-auth0-issuer";

    try {
      parseEnvironment({
        ...validProductionEnvironment,
        AUTH0_ISSUER: secret,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("keeps the test-token route disabled outside test mode", () => {
    expect(isTestTokenRouteEnabled("production")).toBe(false);
    expect(isTestTokenRouteEnabled("development")).toBe(false);
    expect(isTestTokenRouteEnabled("test")).toBe(true);
  });
});
