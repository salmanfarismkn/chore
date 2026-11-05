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

  const result = await redis.eval(
    `
    redis.call("SREM", KEYS[1], ARGV[1])
    return redis.call("SCARD", KEYS[1])
    `,
    {
      keys: [key],
      arguments: [socketId],
    }
  );

  return Number(result);
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