import Fastify from "fastify";

import helmet from "@fastify/helmet";
import cors from "@fastify/cors";

import { env } from "./config/env";
import { logger } from "./config/logger";

import { registerRoutes } from "./routes";

export function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  app.register(helmet);

  app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  app.register(registerRoutes);

  return app;
}