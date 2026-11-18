import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { redis } from "../config/redis";
import { isRealtimeReady } from "../realtime/socket";

const REDIS_READINESS_TIMEOUT_MS = 3_500;

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
    };
  });

  app.get("/ready", async (request, reply) => {
    try {
      if (!redis.isReady) {
        throw new Error("Redis is not ready");
      }

      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          redis.ping(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Redis readiness probe timed out")),
              REDIS_READINESS_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      if (!isRealtimeReady()) {
        throw new Error("Realtime adapter is not ready");
      }

      await db.execute(sql`SELECT 1`);

      return {
        status: "ready",
        database: "ok",
        redis: "ok",
        realtime: "ok",
      };
    } catch (error) {
      request.log.error(error, "Readiness check failed");

      return reply.status(503).send({
        status: "not_ready",
      });
    }
  });
}
