import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { env } from "./env";
import { redis } from "./redis";

export interface RateLimitPolicy {
  name: string;
  max: number;
  windowMs: number;
}

export interface RateLimitDecision {
  count: number;
  ttlMs: number;
}

export type RateLimitCounter = (
  key: string,
  windowMs: number,
) => Promise<RateLimitDecision>;

const fixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if count == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export function createRedisRateLimitCounter(
  execute: (script: string, key: string, windowMs: number) => Promise<unknown>,
  isReady: () => boolean,
): RateLimitCounter {
  return async (key, windowMs) => {
    if (!isReady()) {
      throw new Error("Rate-limit Redis client is not ready");
    }

    const result = await execute(fixedWindowScript, key, windowMs);
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !Number.isSafeInteger(Number(result[0])) ||
      !Number.isFinite(Number(result[1])) ||
      Number(result[0]) < 1 ||
      Number(result[1]) < 0
    ) {
      throw new Error("Invalid rate-limit counter response");
    }

    return { count: Number(result[0]), ttlMs: Number(result[1]) };
  };
}

export const sharedRateLimitCounter = createRedisRateLimitCounter(
  (script, key, windowMs) =>
    redis.eval(script, {
      keys: [key],
      arguments: [String(windowMs)],
    }),
  () => redis.isReady,
);

export const RATE_LIMIT_POLICIES = {
  generalApi: {
    name: "general-api",
    max: env.RATE_LIMIT_GENERAL_MAX,
    windowMs: env.RATE_LIMIT_GENERAL_WINDOW_MS,
  },
  loginInitiation: {
    name: "login-initiation",
    max: env.RATE_LIMIT_AUTH_MAX,
    windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  },
  authorizationCallback: {
    name: "authorization-callback",
    max: env.RATE_LIMIT_AUTH_MAX,
    windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  },
  sessionLogout: {
    name: "session-logout",
    max: env.RATE_LIMIT_AUTH_MAX,
    windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  },
  sessionRevoke: {
    name: "session-revoke",
    max: env.RATE_LIMIT_AUTH_MAX,
    windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  },
  sessionCsrf: {
    name: "session-csrf",
    max: env.RATE_LIMIT_AUTH_MAX,
    windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  },
  testToken: {
    name: "test-token",
    max: env.RATE_LIMIT_AUTH_MAX,
    windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  },
  bookingCreation: {
    name: "booking-creation",
    max: env.RATE_LIMIT_BOOKING_MAX,
    windowMs: env.RATE_LIMIT_BOOKING_WINDOW_MS,
  },
  allocationOfferAcceptance: {
    name: "allocation-offer-acceptance",
    max: env.RATE_LIMIT_ACCEPTANCE_MAX,
    windowMs: env.RATE_LIMIT_ACCEPTANCE_WINDOW_MS,
  },
  bookingAcceptance: {
    name: "booking-acceptance",
    max: env.RATE_LIMIT_ACCEPTANCE_MAX,
    windowMs: env.RATE_LIMIT_ACCEPTANCE_WINDOW_MS,
  },
  adminWorkerCreation: {
    name: "admin-worker-creation",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  adminUserCreation: {
    name: "admin-user-creation",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  adminServiceCreation: {
    name: "admin-service-creation",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  adminWorkerApproval: {
    name: "admin-worker-approval",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  adminOfferCreation: {
    name: "admin-offer-creation",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  workerServiceMutation: {
    name: "worker-service-mutation",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  workerProfileUpdate: {
    name: "worker-profile-update",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  workerProfileDeletion: {
    name: "worker-profile-deletion",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  },
  socketConnection: {
    name: "socket-connection",
    max: env.RATE_LIMIT_SOCKET_MAX,
    windowMs: env.RATE_LIMIT_SOCKET_WINDOW_MS,
  },
} satisfies Record<string, RateLimitPolicy>;

export function rateLimitKey(
  policy: RateLimitPolicy,
  identity: string,
): string {
  if (
    !/^[a-z0-9][a-z0-9-]{0,47}$/.test(policy.name) ||
    !Number.isSafeInteger(policy.max) ||
    policy.max < 1 ||
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1
  ) {
    throw new Error("Invalid rate-limit policy");
  }

  const identityHash = createHash("sha256")
    .update(identity, "utf8")
    .digest("hex");
  return `pronto:rate-limit:v1:${policy.name}:${identityHash}`;
}

export function ipRateLimitIdentity(
  address: string | undefined,
): string | null {
  if (!address) return null;
  const normalized = address.replace(/^::ffff:/i, "");
  return isIP(normalized) ? `ip:${normalized}` : null;
}

export function userRateLimitIdentity(
  userId: number | undefined,
): string | null {
  return typeof userId === "number" &&
    Number.isSafeInteger(userId) &&
    userId > 0
    ? `user:${userId}`
    : null;
}

export async function checkDistributedRateLimit(
  policy: RateLimitPolicy,
  identity: string,
  counter: RateLimitCounter = sharedRateLimitCounter,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { count, ttlMs } = await counter(
    rateLimitKey(policy, identity),
    policy.windowMs,
  );
  return {
    allowed: count <= policy.max,
    retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

export function createDistributedRateLimitPreHandler(
  policy: RateLimitPolicy,
  identityForRequest: (request: FastifyRequest) => string | null,
  counter: RateLimitCounter = sharedRateLimitCounter,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = identityForRequest(request);
    if (!identity) {
      request.log.error("Rate-limit identity unavailable");
      return reply.status(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: "Request protection is temporarily unavailable",
      });
    }

    try {
      const decision = await checkDistributedRateLimit(
        policy,
        identity,
        counter,
      );
      if (!decision.allowed) {
        return reply
          .header("Retry-After", String(decision.retryAfterSeconds))
          .status(429)
          .send({
            statusCode: 429,
            error: "Too Many Requests",
            message: "Rate limit exceeded",
          });
      }
    } catch {
      request.log.error("Distributed rate-limit store unavailable");
      return reply.status(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: "Request protection is temporarily unavailable",
      });
    }
  };
}

export function registerDistributedRateLimits(
  app: FastifyInstance,
  counter: RateLimitCounter = sharedRateLimitCounter,
) {
  const generalApiLimit = createDistributedRateLimitPreHandler(
    RATE_LIMIT_POLICIES.generalApi,
    (request) => {
      const ipIdentity = ipRateLimitIdentity(request.ip);
      const route = request.routeOptions.url;
      if (!ipIdentity || !route || !route.startsWith("/v1/")) return null;
      return `${ipIdentity}:route:${request.method}:${route}`;
    },
    counter,
  );

  app.addHook("onRequest", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/v1/")) return;
    return generalApiLimit(request, reply);
  });
}
