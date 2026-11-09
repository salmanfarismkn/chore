import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  default as sessionAuthPlugin,
} from "./session-auth";

describe("application session HTTP authentication", () => {
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  const buildApp = async (
    overrides: {
      role?: "customer" | "worker" | "admin";
      clientType?: "web" | "native";
      fail?: boolean;
      csrfValid?: boolean;
      workerFailure?: boolean;
    } = {},
  ) => {
    const sessions = {
      authenticate: vi.fn(
        async (_credential: string, _clientType: "web" | "native") => {
          if (overrides.fail) {
            throw new Error("database unavailable");
          }
          return {
            id: "2f0ef055-10d7-4e15-8d61-f8d8ae82d561",
            userId: 31,
            role: overrides.role ?? "customer",
            clientType: overrides.clientType ?? "native",
            csrfTokenHash: "a".repeat(64),
          };
        },
      ),
      authorizeWorker: vi.fn(async () => {
        if (overrides.workerFailure) {
          throw new Error("database unavailable");
        }
      }),
      verifyCsrfToken: vi.fn(async () => overrides.csrfValid ?? true),
    };

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(sessionAuthPlugin, { sessions });
    app.get(
      "/protected",
      { preHandler: [app.authenticate] },
      (request: FastifyRequest) => ({ user: request.user }),
    );
    app.post(
      "/protected",
      { preHandler: [app.authenticate] },
      (request: FastifyRequest) => ({ user: request.user }),
    );
    app.get(
      "/worker",
      { preHandler: [app.authenticate, app.requireWorker] },
      () => ({ ok: true }),
    );
    await app.ready();
    return { app, sessions };
  };

  it("uses the current database role for native bearer sessions", async () => {
    const { app: server, sessions } = await buildApp({
      role: "customer",
      clientType: "native",
    });
    const response = await server.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: "Bearer session-id.secret",
        "x-user-role": "admin",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { userId: 31, role: "customer" },
    });
    expect(sessions.authenticate).toHaveBeenCalledWith(
      "session-id.secret",
      "native",
    );
  });

  it("rejects ambiguous cookie and bearer transport", async () => {
    const { app: server, sessions } = await buildApp();
    const response = await server.inject({
      method: "GET",
      url: "/protected",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=web-session`,
        authorization: "Bearer native-session",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(sessions.authenticate).not.toHaveBeenCalled();
  });

  it("requires an exact web origin and CSRF token for state-changing requests", async () => {
    const { app: server, sessions } = await buildApp({
      clientType: "web",
      csrfValid: true,
    });
    const denied = await server.inject({
      method: "POST",
      url: "/protected",
      headers: { cookie: `${SESSION_COOKIE_NAME}=web-session` },
    });
    const crossOrigin = await server.inject({
      method: "POST",
      url: "/protected",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=web-session`,
        origin: "https://attacker.example",
        "x-csrf-token": "csrf",
      },
    });
    const accepted = await server.inject({
      method: "POST",
      url: "/protected",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=web-session`,
        origin: "http://localhost:5173",
        "x-csrf-token": "csrf",
      },
    });

    expect(denied.statusCode).toBe(403);
    expect(crossOrigin.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(sessions.verifyCsrfToken).toHaveBeenCalledTimes(1);
  });

  it("rejects native browser-origin requests and unapproved workers", async () => {
    const { app: server, sessions } = await buildApp({
      clientType: "native",
      role: "customer",
    });
    const nativeBrowserRequest = await server.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: "Bearer session",
        origin: "https://attacker.example",
      },
    });
    const customerWorkerRequest = await server.inject({
      method: "GET",
      url: "/worker",
      headers: { authorization: "Bearer session" },
    });

    expect(nativeBrowserRequest.statusCode).toBe(401);
    expect(customerWorkerRequest.statusCode).toBe(403);
    expect(sessions.authorizeWorker).not.toHaveBeenCalled();
  });

  it("fails closed with service unavailable on database errors", async () => {
    const { app: server } = await buildApp({ fail: true });
    const response = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer session" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "authentication_unavailable" });
  });
});
