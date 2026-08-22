import fp from "fastify-plugin";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthUser } from "../modules/auth/auth.types";

declare module "fastify" {
  interface FastifyJWT {
    user: AuthUser;
  }

  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

export default fp(async (app) => {
  app.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch (err) {
        return reply.send(err);
      }
    }
  );
});
