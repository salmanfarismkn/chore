import { createClient } from "redis";
import { env } from "../config/env";

export const redis = createClient({
  url: env.REDIS_URL,
});

redis.on("error", (error) => {
  console.error("Redis error:", error);
});

export async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }
}


export async function resetBookingKeys(bookingId: number) {
  const keys = await redis.keys(`booking:${bookingId}:*`);
  if (keys.length > 0) {
    await redis.del(keys);
    console.log(`Cleared keys for booking ${bookingId}:`, keys);
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
