import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseEnvironment } from "./env";
import { isTestTokenRouteEnabled } from "../modules/auth/auth.routes";

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://app:strong-password@postgres:5432/pronto",
  REDIS_URL: "redis://:strong-password@redis:6379",
  JWT_SECRET: "production-secret-that-is-long-enough-123456",
  CORS_ORIGIN: "https://app.example.com",
  TRUST_PROXY: "1",
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

  it("rejects known development placeholders in production", () => {
    expect(() =>
      parseEnvironment({
        ...validProductionEnvironment,
        JWT_SECRET: "replace-with-a-random-secret-at-least-32-characters",
      }),
    ).toThrow(/development or test placeholder/);
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

  it("keeps development defaults compatible", () => {
    const value = parseEnvironment({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/pronto",
      JWT_SECRET: "development-secret-that-is-long-enough-123456",
    });

    expect(value.REDIS_URL).toBe("redis://localhost:6379");
    expect(value.CORS_ORIGIN).toBe("http://localhost:5173");
  });

  it("does not include secret values in validation errors", () => {
    const secret = validProductionEnvironment.JWT_SECRET;

    try {
      parseEnvironment({
        ...validProductionEnvironment,
        JWT_SECRET: "replace-with-a-random-secret-at-least-32-characters",
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
