import { buildApp } from "./app";
import { env } from "./config/env";
import { redis } from "./config/redis";
import { closeDatabase } from "./db";

const app = buildApp();

const start = async () => {
  try {
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });

    const shutdown = async (signal: string) => {
      app.log.info(`Received ${signal}. Shutting down...`);

      try {
        await app.close();
        try {
          if (redis.isOpen) {
            await redis.quit();
          }
        } finally {
          await closeDatabase();
        }

        app.log.info("Graceful shutdown completed");

        process.exit(0);
      } catch (error) {
        app.log.error(error, "Graceful shutdown failed");
        process.exit(1);
      }
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
