import { redis } from "../../config/redis";
import { AllocationLockService } from "./allocation-lock.service";

export class AllocationAcceptanceService {
  constructor(
    private readonly lockService = new AllocationLockService()
  ) {}

  async accept(
    bookingId: number,
    workerId: number
  ): Promise<boolean> {
    const offerKey = `booking:${bookingId}:offer:${workerId}`;
    const winnerKey = `booking:${bookingId}:allocation:winner`;

    const result = await redis.eval(
      `
        local offerWorker = redis.call("HGET", KEYS[1], "workerId")
        local status = redis.call("HGET", KEYS[1], "status")
        local expiresAt = redis.call("HGET", KEYS[1], "expiresAt")

        if not offerWorker then
          return 0
        end

        if offerWorker ~= ARGV[1] then
          return 0
        end

        if status ~= "pending" then
          return 0
        end

        if not expiresAt then
          return 0
        end

        local now = redis.call("TIME")
        local nowMs = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)

        if tonumber(expiresAt) <= nowMs then
          redis.call("HSET", KEYS[1], "status", "expired")
          return 0
        end

        local winner = redis.call("SET", KEYS[2], ARGV[1], "NX")

        if not winner then
          return 0
        end

        redis.call("HSET", KEYS[1], "status", "accepted")

        return 1
      `,
      {
        keys: [offerKey, winnerKey],
        arguments: [workerId.toString()],
      }
    );

    return result === 1;
  }

  async releaseWinner(
    bookingId: number,
    workerId: number
  ) {
    return this.lockService.releaseWinner(
      bookingId,
      workerId
    );
  }
}
