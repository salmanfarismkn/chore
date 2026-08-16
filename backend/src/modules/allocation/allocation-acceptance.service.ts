import { redis } from "../../config/redis";

export class AllocationAcceptanceService {
  async accept(
    bookingId: number,
    workerId: number
  ): Promise<boolean> {
    const offerKey =
      `booking:${bookingId}:offer`;

    const lockKey =
      `booking:${bookingId}:allocation`;

    const result = await redis.eval(
      `
        local offerWorker =
          redis.call("HGET", KEYS[1], "workerId")

        local status =
          redis.call("HGET", KEYS[1], "status")

        local lockWorker =
          redis.call("GET", KEYS[2])

        if not offerWorker then
          return 0
        end

        if status ~= "pending" then
          return 0
        end

        if offerWorker ~= ARGV[1] then
          return 0
        end

        if lockWorker ~= ARGV[1] then
          return 0
        end

        redis.call(
          "HSET",
          KEYS[1],
          "status",
          "accepted"
        )

        return 1
      `,
      {
        keys: [offerKey, lockKey],
        arguments: [workerId.toString()],
      }
    );

    return result === 1;
  }
  
  async releaseLock(
    bookingId: number,
    workerId: number
  ) {
    const lockKey =
      `booking:${bookingId}:allocation`;

    const currentWorker =
      await redis.get(lockKey);

    if (currentWorker !== workerId.toString()) {
      return false;
    }

    await redis.del(lockKey);

    return true;
  }
}