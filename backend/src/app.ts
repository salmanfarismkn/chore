import Fastify from "fastify";

import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

import { env } from "./config/env";
import { connectRedis } from "./config/redis";
import { initializeSocket } from "./realtime/socket";

import { registerHealthRoutes } from "./modules/health/health.routes";
import { registerUserRoutes } from "./modules/users/users.routes";
import { registerErrorHandler } from "./shared/error-handler";
import { registerWorkerRoutes } from "./modules/workers/workers.routes";
import { registerServiceRoutes } from "./modules/service-categories/services.routes";
import { registerWorkerServiceRoutes } from "./modules/worker-services/worker-services.routes";
import { registerBookingRoutes } from "./modules/bookings/bookings.routes";
import { registerAllocationRoutes } from "./modules/allocation/allocation.routes";
import sessionAuthPlugin from "./plugins/session-auth";
import { registerAuthRoutes } from "./modules/auth/auth.routes";
import swaggerPlugin from "./plugins/swagger";
import { registerRoutes } from "./routes";
import { startAllocationRecoveryWorker } from "./modules/allocation/allocation-recovery.worker";
import { registerDistributedRateLimits } from "./config/rate-limit";

function parseTrustProxy(value: string): boolean | number | string {
  if (value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    routerOptions: {
      ignoreTrailingSlash: true,
    },
  });

  registerErrorHandler(app);

  let stopAllocationRecoveryWorker: (() => void) | undefined;

  app.addHook("onReady", async () => {
    await connectRedis();
    initializeSocket(app.server, app);
    stopAllocationRecoveryWorker = startAllocationRecoveryWorker();
  });

  app.addHook("onClose", async () => {
    stopAllocationRecoveryWorker?.();
  });

  app.register(helmet);
  app.register(cookie);

  app.register(cors, {
    origin: env.trustedWebOrigins,
    credentials: true,
  });

  app.register(sessionAuthPlugin);
  registerDistributedRateLimits(app);

  app.register(registerAuthRoutes, {
    prefix: "/v1/auth",
  });

  // Users Module
  app.register(registerUserRoutes, {
    prefix: "/v1/users",
  });

  app.register(registerWorkerRoutes, {
    prefix: "/v1/workers",
  });

  app.register(registerServiceRoutes, {
    prefix: "/v1/service-categories",
  });

  app.register(registerWorkerServiceRoutes, {
    prefix: "/v1/worker-services",
  });

  app.register(registerBookingRoutes, {
    prefix: "/v1/bookings",
  });

  app.register(registerAllocationRoutes, {
    prefix: "/v1/allocation",
  });

  app.register(swaggerPlugin);

  app.register(registerRoutes);

  return app;
}
