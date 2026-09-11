import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

import { db } from "../../db";
import { redis } from "../../config/redis";

export async function registerHealthRoutes(server: FastifyInstance) {
  server.get("/", async () => {
    return {
      status: "ok",
      service: "pronto-backend",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  server.get("/ready", async (request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);

      if (!redis.isReady) {
        throw new Error("Redis is not ready");
      }

      await redis.ping();

      return {
        status: "ready",
        database: "ok",
        redis: "ok",
      };
    } catch (error) {
      request.log.error(error, "Readiness check failed");

      return reply.status(503).send({
        status: "not_ready",
      });
    }
  });
}