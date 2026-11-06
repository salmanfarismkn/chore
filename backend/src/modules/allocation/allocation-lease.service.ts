import { redis } from "../../config/redis";

const LEASE_TTL_SECONDS = 60;

export interface AllocationLease {
  instanceId: string;
  generation: number;
}

export class AllocationLeaseService {
  private getKey(bookingId: number) {
    return `booking:${bookingId}:allocation:lease`;
  }

  async acquire(
    bookingId: number,
    instanceId: string,
    generation: number
  ): Promise<boolean> {
    const result = await redis.set(
      this.getKey(bookingId),
      this.getToken(instanceId, generation),
      {
        NX: true,
        EX: LEASE_TTL_SECONDS,
      }
    );

    return result === "OK";
  }

  async renew(
    bookingId: number,
    instanceId: string,
    generation: number
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
          this.getToken(instanceId, generation),
          LEASE_TTL_SECONDS.toString(),
        ],
      }
    );

    return result === 1;
  }

  async release(
    bookingId: number,
    instanceId: string,
    generation: number
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
        arguments: [this.getToken(instanceId, generation)],
      }
    );

    return result === 1;
  }

  async updateGeneration(
    bookingId: number,
    instanceId: string,
    fromGeneration: number,
    toGeneration: number
  ): Promise<boolean> {
    const result = await redis.eval(
      `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
      end
      return false
      `,
      {
        keys: [this.getKey(bookingId)],
        arguments: [
          this.getToken(instanceId, fromGeneration),
          this.getToken(instanceId, toGeneration),
          LEASE_TTL_SECONDS.toString(),
        ],
      }
    );

    return result === "OK";
  }

  getToken(instanceId: string, generation: number) {
    return `${instanceId}:${generation}`;
  }
}