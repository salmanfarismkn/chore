import Fastify from "fastify";

import helmet from "@fastify/helmet";
import cors from "@fastify/cors";

import { env } from "./config/env";

import { registerHealthRoutes } from "./modules/health/health.routes";
import { registerUserRoutes } from "./modules/users/users.routes";
import { registerErrorHandler } from "./shared/error-handler";
import { registerWorkerRoutes } from "./modules/workers/workers.routes";
import { registerServiceRoutes } from "./modules/service-categories/services.routes";
import { registerWorkerServiceRoutes } from "./modules/worker-services/worker-services.routes";
import { registerBookingRoutes } from "./modules/bookings/bookings.routes";

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
 

  app.register(registerServiceRoutes, {
    prefix: "/v1/services",
  });

  app.register(registerWorkerServiceRoutes, {
    prefix: "/v1/worker-services",
  });

  app.register(registerBookingRoutes, {
    prefix: "/v1/bookings",
  });
  return app;
}
