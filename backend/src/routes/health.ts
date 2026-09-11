import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { redis } from "../config/redis";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
    };
  });

  app.get("/ready", async (request, reply) => {
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