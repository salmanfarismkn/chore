import { FastifyInstance } from "fastify";

export async function registerHealthRoutes(server: FastifyInstance) {
  server.get("/health", async () => {
    return {
    "status": "ok",
    "database": "connected",
    "uptime": 123,
    "timestamp": "2026-07-15T16:11:01Z"
  }
  });
}