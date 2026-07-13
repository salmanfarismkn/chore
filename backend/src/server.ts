import fastify, { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { registerAppRoutes } from "./app/routes";
import { errorHandler } from "./middleware/error.middleware";
import { notFoundHandler } from "./middleware/notFound.middleware";
import { requestLogger } from "./middleware/requestLogger.middleware";
import { env } from "./config/env";
import { logger } from "./config/logger";

export function buildServer(): FastifyInstance {
  const server = fastify({
    logger,
    trustProxy: true,
  });

  server.register(requestLogger);
  server.register(helmet);
  server.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  server.register(cookie);
  server.register(sensible);
  server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  server.register(swagger, {
    openapi: {
      info: {
        title: "Chore API",
        version: "1.0.0",
        description: "Backend API",
      },
    },
  });
  server.register(swaggerUI, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "full",
    },
  });

  registerAppRoutes(server);
  notFoundHandler(server);
  errorHandler(server);

  return server;
}

export default buildServer;
