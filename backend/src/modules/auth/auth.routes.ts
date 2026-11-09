import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { env } from "../../config/env";
import { SessionService } from "../sessions/session.service";
import {
  Auth0LoginFlowError,
  type Auth0AuthorizationCodeFlow,
} from "./auth0-authorization-code-flow";
import { createAuth0AuthorizationCodeFlow } from "./auth0-authorization-code-flow.factory";
import { SESSION_COOKIE_NAME } from "../../plugins/session-auth";
import {
  createDistributedRateLimitPreHandler,
  ipRateLimitIdentity,
  RATE_LIMIT_POLICIES,
  userRateLimitIdentity,
  type RateLimitCounter,
} from "../../config/rate-limit";

const testTokenSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(["customer", "worker", "admin"]),
});

const oidcStartSchema = z
  .object({
    clientType: z.enum(["web", "native"]),
    redirectUri: z.string().min(1).max(2048),
  })
  .strict();

const oidcCallbackSchema = z
  .object({
    state: z.string().min(16).max(128),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(128).optional(),
    contextBinding: z.string().min(43).max(128).optional(),
  })
  .strict()
  .refine(
    (callback) =>
      (typeof callback.code === "string") !==
      (typeof callback.error === "string"),
  );

const LOGIN_CONTEXT_COOKIE_PATH = "/v1/auth/oidc";
const SESSION_COOKIE_PATH = "/v1";
const SESSION_COOKIE_SAME_SITE = "none";

export interface AuthRoutesOptions {
  flow?: Pick<Auth0AuthorizationCodeFlow, "start" | "complete">;
  sessions?: Pick<
    SessionService,
    "create" | "revokeCredential" | "revokeAllForUser" | "renewCsrfToken"
  >;
  rateLimitCounter?: RateLimitCounter;
}

const contextCookieName = (state: string) =>
  `__Secure-oidc_${createHash("sha256")
    .update(state, "utf8")
    .digest("hex")
    .slice(0, 32)}`;

const failureResponse = (error: Auth0LoginFlowError) => {
  if (error.failure === "temporarily_unavailable") {
    return {
      statusCode: 503,
      body: { error: "authentication_unavailable" },
    };
  }
  return { statusCode: 401, body: { error: "authentication_failed" } };
};

const isTrustedOrigin = (origin: string | undefined) =>
  typeof origin === "string" && env.trustedWebOrigins.includes(origin);

export function isTestTokenRouteEnabled(nodeEnv: string): boolean {
  return nodeEnv === "test";
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions = {},
) {
  let flow = options.flow;
  const getFlow = () => {
    flow ??= createAuth0AuthorizationCodeFlow();
    return flow;
  };
  const sessions = options.sessions ?? new SessionService();

  app.get("/test", { preHandler: [app.authenticate] }, async (request) => ({
    message: "Authenticated",
    user: request.user,
  }));

  app.post(
    "/oidc/transactions",
    {
      bodyLimit: 4096,
      preHandler: [
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.loginInitiation,
          (request) => ipRateLimitIdentity(request.ip),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      if (env.NODE_ENV === "production" && request.protocol !== "https") {
        return reply.status(400).send({ error: "invalid_request" });
      }

      const parsed = oidcStartSchema.safeParse(request.body);
      if (
        !parsed.success ||
        (parsed.data.clientType === "web" &&
          !isTrustedOrigin(request.headers.origin)) ||
        (parsed.data.clientType === "native" &&
          request.headers.origin !== undefined)
      ) {
        return reply.status(400).send({ error: "invalid_request" });
      }

      try {
        const started = await getFlow().start(
          parsed.data.clientType,
          parsed.data.redirectUri,
        );
        if (parsed.data.clientType === "web") {
          if (!started.loginContextCookie) {
            throw new Error("Web login context cookie was not created");
          }
          reply.setCookie(
            contextCookieName(
              new URL(started.authorizationUrl).searchParams.get("state")!,
            ),
            started.loginContextCookie,
            {
              httpOnly: true,
              secure: true,
              sameSite: SESSION_COOKIE_SAME_SITE,
              path: LOGIN_CONTEXT_COOKIE_PATH,
              maxAge: 600,
            },
          );
        } else if (!started.nativeContextBinding) {
          throw new Error("Native login context binding was not created");
        }

        return {
          authorizationUrl: started.authorizationUrl,
          expiresAt: started.expiresAt,
          ...(parsed.data.clientType === "native"
            ? { transactionBinding: started.nativeContextBinding }
            : {}),
        };
      } catch (error) {
        if (error instanceof Auth0LoginFlowError) {
          const result = failureResponse(error);
          return reply.status(result.statusCode).send(result.body);
        }
        throw error;
      }
    },
  );

  app.post(
    "/oidc/callback",
    {
      bodyLimit: 8192,
      preHandler: [
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.authorizationCallback,
          (request) => ipRateLimitIdentity(request.ip),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      if (env.NODE_ENV === "production" && request.protocol !== "https") {
        return reply.status(400).send({ error: "authentication_failed" });
      }

      const parsed = oidcCallbackSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "authentication_failed" });
      }

      const origin = request.headers.origin;
      const cookieName = contextCookieName(parsed.data.state);
      const webContext = request.cookies[cookieName];
      if (
        (origin !== undefined &&
          (!isTrustedOrigin(origin) ||
            parsed.data.contextBinding !== undefined ||
            !webContext)) ||
        (origin === undefined &&
          Boolean(parsed.data.contextBinding) === Boolean(webContext))
      ) {
        return reply.status(401).send({ error: "authentication_failed" });
      }

      reply.clearCookie(cookieName, {
        httpOnly: true,
        secure: true,
        sameSite: SESSION_COOKIE_SAME_SITE,
        path: LOGIN_CONTEXT_COOKIE_PATH,
      });

      try {
        const result = await getFlow().complete({
          state: parsed.data.state,
          code: parsed.data.code,
          error: parsed.data.error,
          contextBinding: webContext ?? parsed.data.contextBinding,
        });

        if (result.clientType === "web") {
          reply.setCookie(SESSION_COOKIE_NAME, result.credential, {
            httpOnly: true,
            secure: true,
            sameSite: SESSION_COOKIE_SAME_SITE,
            path: SESSION_COOKIE_PATH,
            expires: result.expiresAt,
          });
          return reply.send({
            status: result.status,
            csrfToken: result.csrfToken,
            expiresAt: result.expiresAt.toISOString(),
          });
        }

        return reply.send({
          status: result.status,
          sessionToken: result.credential,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof Auth0LoginFlowError) {
          const result = failureResponse(error);
          return reply.status(result.statusCode).send(result.body);
        }
        request.log.error("Authentication session creation failed");
        return reply.status(503).send({ error: "authentication_unavailable" });
      }
    },
  );

  app.post(
    "/logout",
    {
      bodyLimit: 1024,
      preHandler: [
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.sessionLogout,
          (request) => ipRateLimitIdentity(request.ip),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      const cookieCredential = request.cookies[SESSION_COOKIE_NAME];
      const authorization = request.headers.authorization;
      const csrfHeader = request.headers["x-csrf-token"];
      const csrfToken = typeof csrfHeader === "string" ? csrfHeader : undefined;

      try {
        if (cookieCredential && authorization === undefined) {
          if (isTrustedOrigin(request.headers.origin)) {
            await sessions.revokeCredential(cookieCredential, "web", csrfToken);
          }
        } else if (
          !cookieCredential &&
          typeof authorization === "string" &&
          authorization.startsWith("Bearer ") &&
          request.headers.origin === undefined
        ) {
          await sessions.revokeCredential(
            authorization.slice("Bearer ".length),
            "native",
          );
        }
      } catch (error) {
        request.log.error("Session revocation dependency failed");
        reply.clearCookie(SESSION_COOKIE_NAME, {
          httpOnly: true,
          secure: true,
          sameSite: SESSION_COOKIE_SAME_SITE,
          path: SESSION_COOKIE_PATH,
        });
        return reply.status(503).send({ error: "authentication_unavailable" });
      }

      reply.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: SESSION_COOKIE_SAME_SITE,
        path: SESSION_COOKIE_PATH,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/sessions/revoke",
    {
      preHandler: [
        app.authenticate,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.sessionRevoke,
          (request) =>
            userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      const userId = request.appSession!.userId;
      try {
        await sessions.revokeAllForUser(userId);
        return reply.status(204).send();
      } catch {
        request.log.error("Session revocation dependency failed");
        return reply.status(503).send({ error: "authentication_unavailable" });
      }
    },
  );

  app.get(
    "/sessions/csrf",
    {
      preHandler: [
        app.authenticate,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.sessionCsrf,
          (request) =>
            userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      const session = request.appSession!;
      if (session.clientType !== "web") {
        return reply.send({ csrfToken: null });
      }

      const origin = request.headers.origin;
      const sameOriginFetch =
        request.headers["sec-fetch-site"] === "same-origin";
      if (
        !isTrustedOrigin(origin) &&
        !(origin === undefined && sameOriginFetch)
      ) {
        return reply.status(403).send({ error: "origin_not_allowed" });
      }

      try {
        return reply.send({
          csrfToken: await sessions.renewCsrfToken(session.id),
        });
      } catch {
        request.log.error("CSRF token renewal dependency failed");
        return reply.status(503).send({ error: "authentication_unavailable" });
      }
    },
  );

  if (isTestTokenRouteEnabled(env.NODE_ENV)) {
    app.post(
      "/test-token",
      {
        preHandler: [
          createDistributedRateLimitPreHandler(
            RATE_LIMIT_POLICIES.testToken,
            (request) => ipRateLimitIdentity(request.ip),
            options.rateLimitCounter,
          ),
        ],
      },
      async (request, reply) => {
        const parsed = testTokenSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            message: "Invalid request body",
            errors: parsed.error.flatten(),
          });
        }

        try {
          const session = await sessions.create(parsed.data.userId, "native");
          return { token: session.credential };
        } catch {
          return reply.status(401).send({ error: "authentication_failed" });
        }
      },
    );
  }
}
