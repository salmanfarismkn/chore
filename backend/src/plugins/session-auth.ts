import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../config/env";
import {
  AppSessionError,
  SessionService,
  type AuthenticatedAppSession,
} from "../modules/sessions/session.service";
import type { AuthUser } from "../modules/auth/auth.types";

declare module "fastify" {
  interface FastifyRequest {
    appSession?: AuthenticatedAppSession;
    user: AuthUser;
  }

  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    requireWorker: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    requireAvailableWorker: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

const SESSION_COOKIE_NAME = "__Secure-pronto_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SessionAuthOptions {
  sessions?: Pick<
    SessionService,
    "authenticate" | "authorizeWorker" | "verifyCsrfToken"
  >;
}

const unauthorized = (reply: FastifyReply) =>
  reply.status(401).send({ error: "unauthorized" });

const sessionAuthPlugin: FastifyPluginAsync<SessionAuthOptions> = async (
  app,
  options,
) => {
  const sessions = options.sessions ?? new SessionService();

  app.decorate("authenticate", async (request, reply) => {
    const cookieCredential = request.cookies[SESSION_COOKIE_NAME];
    const authorization = request.headers.authorization;

    if (
      (cookieCredential && authorization !== undefined) ||
      (!cookieCredential && authorization === undefined) ||
      (authorization !== undefined &&
        (typeof authorization !== "string" ||
          !authorization.startsWith("Bearer ") ||
          authorization.length <= "Bearer ".length))
    ) {
      unauthorized(reply);
      return;
    }

    const clientType = cookieCredential ? "web" : "native";
    const credential =
      cookieCredential ?? authorization!.slice("Bearer ".length);
    try {
      const session = await sessions.authenticate(credential, clientType);
      if (
        session.clientType === "native" &&
        request.headers.origin !== undefined
      ) {
        unauthorized(reply);
        return;
      }

      request.appSession = session;
      request.user = { userId: session.userId, role: session.role } as AuthUser;

      if (session.clientType === "web" && !SAFE_METHODS.has(request.method)) {
        const origin = request.headers.origin;
        const csrfToken = request.headers["x-csrf-token"];
        if (
          typeof origin !== "string" ||
          !env.trustedWebOrigins.includes(origin) ||
          (typeof csrfToken !== "string" && !Array.isArray(csrfToken)) ||
          (Array.isArray(csrfToken) && csrfToken.length !== 1) ||
          !(await sessions.verifyCsrfToken(
            session,
            Array.isArray(csrfToken) ? csrfToken[0] : csrfToken,
          ))
        ) {
          reply.status(403).send({ error: "csrf_validation_failed" });
        }
      } else if (
        session.clientType === "web" &&
        typeof request.headers.origin === "string" &&
        !env.trustedWebOrigins.includes(request.headers.origin)
      ) {
        reply.status(403).send({ error: "origin_not_allowed" });
      }
    } catch (error) {
      if (error instanceof AppSessionError) {
        unauthorized(reply);
        return;
      }

      request.log.error(
        { err: error },
        "Session authentication dependency failed",
      );
      reply.status(503).send({ error: "authentication_unavailable" });
    }
  });

  app.decorate("requireWorker", async (request, reply) => {
    if (request.appSession?.role === "admin") {
      return;
    }
    if (request.appSession?.role !== "worker") {
      reply.status(403).send({ error: "forbidden" });
      return;
    }

    try {
      await sessions.authorizeWorker(request.appSession.userId);
    } catch (error) {
      if (error instanceof AppSessionError) {
        reply.status(403).send({ error: "forbidden" });
        return;
      }
      request.log.error(
        { err: error },
        "Worker authorization dependency failed",
      );
      reply.status(503).send({ error: "authorization_unavailable" });
    }
  });
  app.decorate("requireAvailableWorker", async (request, reply) => {
    if (request.appSession?.role === "admin") {
      return;
    }
    if (request.appSession?.role !== "worker") {
      reply.status(403).send({ error: "forbidden" });
      return;
    }
    try {
      await sessions.authorizeWorker(request.appSession.userId, true);
    } catch (error) {
      if (error instanceof AppSessionError) {
        reply.status(403).send({ error: "forbidden" });
        return;
      }
      request.log.error(
        { err: error },
        "Worker authorization dependency failed",
      );
      reply.status(503).send({ error: "authorization_unavailable" });
    }
  });
};

export { SESSION_COOKIE_NAME };
export default fp(sessionAuthPlugin);
