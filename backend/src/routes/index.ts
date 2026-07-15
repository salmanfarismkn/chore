import { FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./health";

export async function registerRoutes(server: FastifyInstance) {
  await server.register(registerHealthRoutes);
}