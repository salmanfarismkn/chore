import "dotenv/config";
import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z
    .string()
    .url("REDIS_URL must be a valid URL")
    .default("redis://localhost:6379"),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must contain at least 32 characters"),

  JWT_EXPIRES_IN: z
    .string()
    .min(1)
    .default("15m"),

  CORS_ORIGIN: z
    .string()
    .default("http://localhost:5173"),

  TRUST_PROXY: z
    .string()
    .default("false"),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_BOOKING_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_BOOKING_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_ACCEPTANCE_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_ACCEPTANCE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

const developmentOnlySecrets = new Set([
  "replace-with-a-random-secret-at-least-32-characters",
  "development-secret",
  "test-secret",
  "secret",
  "abcdefghijklmnopqrstuvwxyz123456",
]);

function containsPlaceholder(value: string): boolean {
  return /(?:replace-with|change-me|your[-_])/i.test(value);
}

function isDevelopmentDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      (url.username === "postgres" && url.password === "postgres")
    );
  } catch {
    return false;
  }
}

function isDevelopmentRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function parseEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const parsed = baseEnvSchema.safeParse(source);

  if (!parsed.success) {
    throw parsed.error;
  }

  const value = parsed.data;
  const issues: z.core.$ZodIssue[] = [];

  if (value.NODE_ENV === "production") {
    if (!source.REDIS_URL?.trim()) {
      issues.push({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL is required in production",
      });
    }

    if (
      developmentOnlySecrets.has(value.JWT_SECRET.toLowerCase()) ||
      containsPlaceholder(value.JWT_SECRET)
    ) {
      issues.push({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "JWT_SECRET must not use a development or test placeholder",
      });
    }

    if (
      isDevelopmentDatabaseUrl(value.DATABASE_URL) ||
      containsPlaceholder(value.DATABASE_URL)
    ) {
      issues.push({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must reference a production database",
      });
    }

    if (isDevelopmentRedisUrl(value.REDIS_URL) || containsPlaceholder(value.REDIS_URL)) {
      issues.push({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL must reference a production Redis service",
      });
    }

    if (!source.CORS_ORIGIN?.trim()) {
      issues.push({
        code: "custom",
        path: ["CORS_ORIGIN"],
        message: "CORS_ORIGIN is required in production",
      });
    }
  }

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return value;
}

export const env = (() => {
  try {
    return parseEnvironment();
  } catch (error) {
    console.error("Invalid environment configuration:");

    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        console.error(`- ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      console.error("- Invalid environment configuration");
    }

    process.exit(1);
  }
})();