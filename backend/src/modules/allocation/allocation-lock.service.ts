import { redis } from "../../config/redis";

export class AllocationLockService {
  private getWinnerKey(bookingId: number) {
    return `booking:${bookingId}:allocation:winner`;
  }

  async acquireWinner(
    bookingId: number,
    workerId: number
  ): Promise<boolean> {
    const key = this.getWinnerKey(bookingId);

    const result = await redis.set(
      key,
      workerId.toString(),
      {
        NX: true, 
      }
    );

    return result === "OK";
  }

  async getWinner(
    bookingId: number
  ): Promise<number | null> {
    const key = this.getWinnerKey(bookingId);

    const workerId = await redis.get(key);

    return workerId ? Number(workerId) : null;
  }

  async releaseWinner(
    bookingId: number,
    workerId: number
  ): Promise<boolean> {
    const key = this.getWinnerKey(bookingId);

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

  async acquire(
    bookingId: number,
    workerId: number,
    ttlSeconds: number
  ): Promise<boolean> {
    const lockKey = `booking:${bookingId}:allocation:winner`;

    // Try to set the lock in Redis with expiry
    const result = await redis.set(lockKey, workerId.toString(), {
      NX: true, // only set if not exists
      EX: ttlSeconds, // expire after ttlSeconds
    });

    return result === "OK";
  }
}
