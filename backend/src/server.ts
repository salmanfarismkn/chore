import { buildApp } from "./app";
import { env } from "./config/env";
import { connectRedis } from "./config/redis";
import { initializeSocket } from "./realtime/socket";

async function start() {
  const app = buildApp();
  await connectRedis();
  
  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    
    initializeSocket(
      app.server,
      app
    );

    app.log.info(`Server running at http://${env.HOST}:${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();