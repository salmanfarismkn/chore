import { redis } from "../../config/redis";
import { AllocationLockService } from "./allocation-lock.service";

const PENDING_OFFERS_INDEX = "allocation:offers:pending";

export class AllocationAcceptanceService {
  constructor(
    private readonly lockService = new AllocationLockService()
  ) {}

  async accept(
    bookingId: number,
    workerId: number,
    generation?: number
  ): Promise<boolean> {
    const offerKey = `booking:${bookingId}:offer:${workerId}`;
    const winnerKey = `booking:${bookingId}:allocation:winner`;
    const result = await redis.eval(
      `
        local offerWorker = redis.call("HGET", KEYS[1], "workerId")
        local status = redis.call("HGET", KEYS[1], "status")
        local offerGeneration = redis.call("HGET", KEYS[1], "generation")
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

        if ARGV[2] ~= "" and offerGeneration ~= ARGV[2] then
          return 0
        end

        if not expiresAt then
          return 0
        end

        local now = redis.call("TIME")
        local nowMs = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)

        if tonumber(expiresAt) <= nowMs then
          redis.call("HSET", KEYS[1], "status", "expired")
          redis.call("SREM", KEYS[3], KEYS[1])
          redis.call("SREM", KEYS[4], KEYS[1])
          return 0
        end

        local winner = redis.call("SET", KEYS[2], ARGV[3], "NX", "EX", "60")

        if not winner then
          return 0
        end

        redis.call("HSET", KEYS[1], "status", "accepted")
        redis.call("SREM", KEYS[3], KEYS[1])
        redis.call("SREM", KEYS[4], KEYS[1])

        return 1
      `,
      {
        keys: [
          offerKey,
          winnerKey,
          PENDING_OFFERS_INDEX,
          `worker:${workerId}:offers:pending`,
        ],
        arguments: [
          workerId.toString(),
          generation === undefined ? "" : generation.toString(),
          generation === undefined
            ? workerId.toString()
            : `${workerId}:${generation}`,
        ],
      }
    );
    return result === 1;
  }

  async releaseWinner(
    bookingId: number,
    workerId: number,
    generation?: number
  ) {
    return this.lockService.releaseWinner(
      bookingId,
      workerId,
      generation
    );
  }

  async rollbackAcceptance(
    bookingId: number,
    workerId: number,
    generation?: number
  ): Promise<boolean> {
    const result = await redis.eval(
      `
        if redis.call("GET", KEYS[2]) ~= ARGV[3] then
          return 0
        end

        local offerWorker = redis.call("HGET", KEYS[1], "workerId")
        local status = redis.call("HGET", KEYS[1], "status")
        local offerGeneration = redis.call("HGET", KEYS[1], "generation")
        local expiresAt = redis.call("HGET", KEYS[1], "expiresAt")

        if offerWorker == ARGV[1] and status == "accepted" then
          if ARGV[2] ~= "" and offerGeneration ~= ARGV[2] then
            return 0
          end
          local now = redis.call("TIME")
          local nowMs = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)

          if expiresAt and tonumber(expiresAt) > nowMs then
            redis.call("HSET", KEYS[1], "status", "pending")
            redis.call("SADD", KEYS[3], KEYS[1])
            redis.call("SADD", KEYS[4], KEYS[1])
          elseif offerWorker then
            redis.call("HSET", KEYS[1], "status", "expired")
          end
        end

        redis.call("DEL", KEYS[2])
        return 1
      `,
      {
        keys: [
          `booking:${bookingId}:offer:${workerId}`,
          `booking:${bookingId}:allocation:winner`,
          PENDING_OFFERS_INDEX,
          `worker:${workerId}:offers:pending`,
        ],
        arguments: [
          workerId.toString(),
          generation === undefined ? "" : generation.toString(),
          generation === undefined
            ? workerId.toString()
            : `${workerId}:${generation}`,
        ],
      }
    );

    return result === 1;
  }
}
