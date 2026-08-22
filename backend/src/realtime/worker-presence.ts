import { redis } from "../config/redis";

export async function addWorkerConnection(
  workerId: number,
  socketId: string
) {
  await redis.sAdd(
    `worker:${workerId}:connections`,
    socketId
  );
}

export async function removeWorkerConnection(
  workerId: number,
  socketId: string
) {
  const key =
    `worker:${workerId}:connections`;

  await redis.sRem(
    key,
    socketId
  );

  return redis.sCard(key);
}

export async function getWorkerConnections(
  workerId: number
): Promise<string[]> {
  return redis.sMembers(
    `worker:${workerId}:connections`
  );
}

export async function isWorkerOnline(
  workerId: number
): Promise<boolean> {
  const count = await redis.sCard(
    `worker:${workerId}:connections`
  );
  return count > 0;
}