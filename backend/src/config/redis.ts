import { createClient } from "redis";
import { env } from "../config/env";
import { DependencyUnavailableError } from "../shared/core/errors/dependency-unavailable-error";

export const REDIS_COMMAND_TIMEOUT_MS = 3_000;
const REDIS_CONNECT_TIMEOUT_MS = 2_500;

export const redis = createClient({
  url: env.REDIS_URL,
  socket: {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    reconnectStrategy: (retries) => Math.min(1_000 * (retries + 1), 5_000),
  },
  commandOptions: {
    timeout: REDIS_COMMAND_TIMEOUT_MS,
  },
  commandsQueueMaxLength: 1_000,
  disableOfflineQueue: true,
});

redis.on("error", () => {
  console.error("Redis connection error");
});

export async function withRedisCommandTimeout<T>(
  command: Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      command,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new DependencyUnavailableError("redis")),
          REDIS_COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function connectRedis() {
  if (!redis.isOpen) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        redis.connect(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new DependencyUnavailableError("redis")),
            REDIS_CONNECT_TIMEOUT_MS * 2,
          );
        }),
      ]);
    } catch {
      redis.destroy();
      throw new DependencyUnavailableError("redis");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function resetBookingKeys(bookingId: number) {
  const keys: string[] = [];

  for await (const batch of redis.scanIterator({
    MATCH: `booking:${bookingId}:*`,
    COUNT: 100,
  })) {
    keys.push(...batch);
  }

  for (const key of keys) {
    await redis.del(key);
  }
}

export async function addWorkerConnection(workerId: number, socketId: string) {
  const key = `worker:${workerId}:connections`;
  await redis.sAdd(key, socketId);
}

export async function removeWorkerConnection(
  workerId: number,
  socketId: string,
) {
  const key = `worker:${workerId}:connections`;
  await redis.sRem(key, socketId);
}

export async function getWorkerConnections(
  workerId: number,
): Promise<string[]> {
  const key = `worker:${workerId}:connections`;
  return await redis.sMembers(key);
}

export async function isWorkerOnline(workerId: number): Promise<boolean> {
  const key = `worker:${workerId}:connections`;
  const count = await redis.sCard(key);
  return count > 0;
}
