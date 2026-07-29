import { FastifyInstance } from "fastify";

export async function registerHealthRoutes(server: FastifyInstance) {
  server.get("/", async () => {
    return {
      status: "ok",
      service: "pronto-backend",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });
}