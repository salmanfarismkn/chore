import Fastify from "fastify";

import helmet from "@fastify/helmet";
import cors from "@fastify/cors";

import { env } from "./config/env";

import { registerHealthRoutes } from "./modules/health/health.routes";
import { registerUserRoutes } from "./modules/users/users.routes";
import { registerErrorHandler } from "./shared/error-handler";
import { registerWorkerRoutes } from "./modules/worker/workers.routes";

export function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  registerErrorHandler(app);

  app.register(helmet);

  app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  // Health Module
  app.register(registerHealthRoutes, {
    prefix: "/health",
  });

  // Users Module
  app.register(registerUserRoutes, {
    prefix: "/v1/users",
  });

  app.register(registerWorkerRoutes, {
  prefix: "/v1/workers",
  });

  return app;
}