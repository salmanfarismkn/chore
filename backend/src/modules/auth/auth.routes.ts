import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { z } from "zod";

const testTokenSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(["customer", "worker", "admin"]),
});

export function isTestTokenRouteEnabled(nodeEnv: string): boolean {
  return nodeEnv === "test";
}

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

  if (isTestTokenRouteEnabled(env.NODE_ENV)) {
    app.post(
      "/test-token",
      {
        config: {
          rateLimit: {
            max: env.RATE_LIMIT_AUTH_MAX,
            timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS,
          },
        },
      },
      async (request, reply) => {
        const parsed = testTokenSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            message: "Invalid request body",
            errors: parsed.error.flatten(),
          });
        }

        const token =
          await app.jwt.sign({
            userId: parsed.data.userId,
            role: parsed.data.role,
          });

        return {
          token,
        };
      }
    );
  }
}