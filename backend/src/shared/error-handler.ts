import { FastifyInstance } from "fastify";
import { AppError } from "./core/errors/app-error";
import { DependencyUnavailableError } from "./core/errors/dependency-unavailable-error";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DependencyUnavailableError) {
      request.log.error(
        { dependency: error.dependency },
        "Required service unavailable",
      );
      return reply.status(503).send({
        message: "Service temporarily unavailable",
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        message: error.message,
      });
    }

    request.log.error(error);

    return reply.status(500).send({
      message: "Internal Server Error",
    });
  });
}
