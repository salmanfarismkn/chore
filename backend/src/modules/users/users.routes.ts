import { FastifyInstance } from "fastify";

export async function registerUserRoutes(server: FastifyInstance) {
  server.post("/", async (_request, reply) => {
    return reply.code(501).send({
      message: "Create user endpoint not implemented yet",
    });
  });
}