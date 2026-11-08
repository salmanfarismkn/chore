import "dotenv/config";
import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z
    .string()
    .url("REDIS_URL must be a valid URL")
    .default("redis://localhost:6379"),

  APP_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(86_400)
    .default(3_600),

  AUTH0_ISSUER: z.string().optional(),
  AUTH0_CLIENT_IDS: z.string().optional(),
  AUTH0_WEB_CLIENT_ID: z.string().optional(),
  AUTH0_NATIVE_CLIENT_ID: z.string().optional(),
  AUTH0_WEB_REDIRECT_URIS: z.string().optional(),
  AUTH0_NATIVE_REDIRECT_URIS: z.string().optional(),

  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  TRUST_PROXY: z.string().default("false"),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_BOOKING_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_BOOKING_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  RATE_LIMIT_ACCEPTANCE_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_ACCEPTANCE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  RATE_LIMIT_ADMIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_ADMIN_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  RATE_LIMIT_GENERAL_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_GENERAL_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  RATE_LIMIT_SOCKET_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_SOCKET_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
});

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

function isValidAuth0RedirectUri(
  value: string,
  clientType: "web" | "native",
): boolean {
  try {
    const url = new URL(value);
    const isHttps = url.protocol === "https:";
    const isCustomNativeScheme =
      clientType === "native" &&
      url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      !["data:", "file:", "javascript:"].includes(url.protocol) &&
      /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol);

    return (
      (clientType === "web" ? isHttps : isHttps || isCustomNativeScheme) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.href === value &&
      (!isHttps || url.hostname.length > 0) &&
      value.trim() === value &&
      !value.includes("*")
    );
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
  const trustedWebOrigins = value.CORS_ORIGIN.split(",").map((origin) =>
    origin.trim(),
  );

  if (
    trustedWebOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        const secure = url.protocol === "https:";
        const localDevelopmentOrigin =
          value.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname);
        return (
          (!secure && !localDevelopmentOrigin) ||
          url.origin !== origin ||
          url.username !== "" ||
          url.password !== "" ||
          origin.includes("*")
        );
      } catch {
        return true;
      }
    }) ||
    new Set(trustedWebOrigins).size !== trustedWebOrigins.length
  ) {
    issues.push({
      code: "custom",
      path: ["CORS_ORIGIN"],
      message: "CORS_ORIGIN must be an exact comma-separated origin allowlist",
    });
  }

  if (value.NODE_ENV === "production") {
    if (!source.AUTH0_ISSUER?.trim()) {
      issues.push({
        code: "custom",
        path: ["AUTH0_ISSUER"],
        message: "AUTH0_ISSUER is required in production",
      });
    } else {
      try {
        const issuer = new URL(source.AUTH0_ISSUER);
        if (
          issuer.protocol !== "https:" ||
          issuer.hostname.length === 0 ||
          issuer.username !== "" ||
          issuer.password !== "" ||
          issuer.pathname !== "/" ||
          issuer.search !== "" ||
          issuer.hash !== "" ||
          !source.AUTH0_ISSUER.endsWith("/") ||
          source.AUTH0_ISSUER.trim() !== source.AUTH0_ISSUER ||
          source.AUTH0_ISSUER.includes("*") ||
          containsPlaceholder(source.AUTH0_ISSUER)
        ) {
          throw new Error();
        }
      } catch {
        issues.push({
          code: "custom",
          path: ["AUTH0_ISSUER"],
          message: "AUTH0_ISSUER must be an exact HTTPS Auth0 issuer URL",
        });
      }
    }

    const rawAuth0ClientIds = source.AUTH0_CLIENT_IDS?.split(",");
    const auth0ClientIds = rawAuth0ClientIds?.map((clientId) =>
      clientId.trim(),
    );

    if (
      !auth0ClientIds?.length ||
      auth0ClientIds.length !== 2 ||
      auth0ClientIds.some(
        (clientId) => clientId.length === 0 || clientId.includes("*"),
      ) ||
      rawAuth0ClientIds?.some(
        (clientId, index) => clientId !== auth0ClientIds[index],
      ) ||
      new Set(auth0ClientIds).size !== auth0ClientIds.length ||
      auth0ClientIds.some(
        (clientId) => clientId.includes("*") || containsPlaceholder(clientId),
      )
    ) {
      issues.push({
        code: "custom",
        path: ["AUTH0_CLIENT_IDS"],
        message:
          "AUTH0_CLIENT_IDS must be a comma-separated allowlist of exact Auth0 application client IDs",
      });
    }

    const webClientId = source.AUTH0_WEB_CLIENT_ID;
    const nativeClientId = source.AUTH0_NATIVE_CLIENT_ID;
    if (
      !webClientId ||
      !nativeClientId ||
      webClientId.trim() !== webClientId ||
      nativeClientId.trim() !== nativeClientId ||
      webClientId === nativeClientId ||
      containsPlaceholder(webClientId) ||
      containsPlaceholder(nativeClientId) ||
      webClientId.includes("*") ||
      nativeClientId.includes("*")
    ) {
      issues.push({
        code: "custom",
        path: ["AUTH0_WEB_CLIENT_ID"],
        message:
          "Distinct, exact web and native Auth0 client IDs are required in production",
      });
    } else if (
      auth0ClientIds?.length !== 2 ||
      !auth0ClientIds.includes(webClientId) ||
      !auth0ClientIds.includes(nativeClientId)
    ) {
      issues.push({
        code: "custom",
        path: ["AUTH0_CLIENT_IDS"],
        message:
          "AUTH0_CLIENT_IDS must exactly match AUTH0_WEB_CLIENT_ID and AUTH0_NATIVE_CLIENT_ID",
      });
    }

    for (const [clientType, rawUris] of [
      ["web", source.AUTH0_WEB_REDIRECT_URIS],
      ["native", source.AUTH0_NATIVE_REDIRECT_URIS],
    ] as const) {
      const redirectUris = rawUris?.split(",");
      if (
        !redirectUris?.length ||
        redirectUris.some(
          (uri) =>
            uri.trim() !== uri ||
            containsPlaceholder(uri) ||
            !isValidAuth0RedirectUri(uri, clientType),
        ) ||
        new Set(redirectUris).size !== redirectUris.length
      ) {
        issues.push({
          code: "custom",
          path: [
            clientType === "web"
              ? "AUTH0_WEB_REDIRECT_URIS"
              : "AUTH0_NATIVE_REDIRECT_URIS",
          ],
          message: `AUTH0_${clientType.toUpperCase()}_REDIRECT_URIS must be an exact allowlist of valid callback URIs`,
        });
      }
    }

    if (!source.REDIS_URL?.trim()) {
      issues.push({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL is required in production",
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

    if (
      isDevelopmentRedisUrl(value.REDIS_URL) ||
      containsPlaceholder(value.REDIS_URL)
    ) {
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

    const trustProxyHops = /^\d+$/.test(value.TRUST_PROXY)
      ? Number(value.TRUST_PROXY)
      : null;
    if (
      !source.TRUST_PROXY?.trim() ||
      value.TRUST_PROXY === "false" ||
      value.TRUST_PROXY === "true" ||
      (trustProxyHops !== null && trustProxyHops < 1) ||
      containsPlaceholder(value.TRUST_PROXY) ||
      value.TRUST_PROXY.includes("*")
    ) {
      issues.push({
        code: "custom",
        path: ["TRUST_PROXY"],
        message:
          "TRUST_PROXY must be a nonzero, non-global setting for trusted TLS ingress in production",
      });
    }
  }

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return { ...value, trustedWebOrigins };
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
