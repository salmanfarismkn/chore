import { FastifyInstance } from "fastify";
import { AppError } from "./core/errors/app-error";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
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