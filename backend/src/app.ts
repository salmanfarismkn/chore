import { FastifyInstance } from "fastify";
import { registerAppRoutes } from "./app/routes";

export function createApp(server: FastifyInstance): FastifyInstance {
  registerAppRoutes(server);
  return server;
}
