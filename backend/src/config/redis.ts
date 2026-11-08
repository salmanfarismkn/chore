import { createClient } from "redis";
import { env } from "../config/env";

export const redis = createClient({
  url: env.REDIS_URL,
});

redis.on("error", () => {
  console.error("Redis connection error");
});

export async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
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

export async function removeWorkerConnection(workerId: number, socketId: string) {
  const key = `worker:${workerId}:connections`;
  await redis.sRem(key, socketId);
}

export async function getWorkerConnections(workerId: number): Promise<string[]> {
  const key = `worker:${workerId}:connections`;
  return await redis.sMembers(key);
}

export async function isWorkerOnline(workerId: number): Promise<boolean> {
  const key = `worker:${workerId}:connections`;
  const count = await redis.sCard(key);
  return count > 0;
}
