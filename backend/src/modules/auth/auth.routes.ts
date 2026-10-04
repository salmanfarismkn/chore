import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";

export async function registerAuthRoutes(
  app: FastifyInstance
) {
  app.get(
    "/test",
    {
      preHandler: [
        app.authenticate,
      ],
    },
    async (request) => {
      return {
        message: "Authenticated",
        user: request.user,
      };
    }
  );

  if (env.NODE_ENV === "test") {
    app.post(
      "/test-token",
      async (request) => {
        const body = request.body as {
          userId: number;
          role:
            | "customer"
            | "worker"
            | "admin";
        };

        const token =
          await app.jwt.sign({
            userId: body.userId,
            role: body.role,
          });

        return {
          token,
        };
      }
    );
  }
}