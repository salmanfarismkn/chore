import { redis } from "../../config/redis";

const LEASE_TTL_SECONDS = 60;

export class AllocationLeaseService {
  private getKey(bookingId: number) {
    return `booking:${bookingId}:allocation:lease`;
  }

  async acquire(
    bookingId: number,
    instanceId: string
  ): Promise<boolean> {
    const result = await redis.set(
      this.getKey(bookingId),
      instanceId,
      {
        NX: true,
        EX: LEASE_TTL_SECONDS,
      }
    );

    return result === "OK";
  }

  async renew(
    bookingId: number,
    instanceId: string
  ): Promise<boolean> {
    const key = this.getKey(bookingId);

    const result = await redis.eval(
      `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("EXPIRE", KEYS[1], ARGV[2])
      end
      return 0
      `,
      {
        keys: [key],
        arguments: [
          instanceId,
          LEASE_TTL_SECONDS.toString(),
        ],
      }
    );

    return result === 1;
  }

  async release(
    bookingId: number,
    instanceId: string
  ): Promise<boolean> {
    const result = await redis.eval(
      `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
      `,
      {
        keys: [this.getKey(bookingId)],
        arguments: [instanceId],
      }
    );

    return result === 1;
  }
}