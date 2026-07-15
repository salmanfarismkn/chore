import { buildApp } from "./app";
import { env } from "./config/env";

async function start() {
  const app = buildApp();

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });

    app.log.info(`Server running at http://${env.HOST}:${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();