import { redis } from "../../config/redis";

export class AllocationLockService {
  async acquire(
    bookingId: number,
    workerId: number,
    ttlSeconds: number
  ): Promise<boolean> {
    const key = `booking:${bookingId}:allocation`;

    const value = workerId.toString();

    const result = await redis.set(
      key,
      value,
      {
        NX: true,
        EX: ttlSeconds,
      }
    );

    return result === "OK";
  }

  async getWorker(
    bookingId: number
  ): Promise<number | null> {
    const key = `booking:${bookingId}:allocation`;

    const value = await redis.get(key);

    return value ? Number(value) : null;
  }

    async release(
    bookingId: number,
    workerId: number
    ): Promise<boolean> {
    const key =
        `booking:${bookingId}:allocation`;

    const result = await redis.eval(
        `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        end

        return 0
        `,
        {
        keys: [key],
        arguments: [workerId.toString()],
        }
    );

    return result === 1;
    }
}