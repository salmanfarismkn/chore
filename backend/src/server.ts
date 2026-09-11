import { buildApp } from "./app";
import { env } from "./config/env";
import { initializeSocket } from "./realtime/socket";
import { redis } from "./config/redis";

const app = buildApp();

const start = async () => {
  try {
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });

    const io = initializeSocket(app.server, app);

    const shutdown = async (signal: string) => {
      app.log.info(`Received ${signal}. Shutting down...`);

      try {
        // Stop accepting new HTTP connections
        await app.close();

        // Close Socket.IO connections
        io.close();

        // Close Redis connection
        await redis.quit();

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