import { redis } from "../../config/redis";
import { AllocationLockService } from "./allocation-lock.service";

export class AllocationOfferService {
  constructor(
    private readonly lockService = new AllocationLockService(),
    private expirationTimers = new Map<number, NodeJS.Timeout>()
  ) {}

  async createOffer(
    bookingId: number,
    workerId: number,
    tier: string,
    ttlSeconds: number
  ) {
    const acquired = await this.lockService.acquire(
      bookingId,
      workerId,
      ttlSeconds
    );

    if (!acquired) {
      return null;
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const offerKey = `booking:${bookingId}:offer:worker:${workerId}`;

    await redis.hSet(offerKey, {
      bookingId: bookingId.toString(),
      workerId: workerId.toString(),
      tier,
      expiresAt: expiresAt.toISOString(),
      status: "pending",
    });

    await redis.expire(offerKey, ttlSeconds);

    const expiryKey = `allocation:expiring:${bookingId}`;
    await redis.set(
      expiryKey,
      JSON.stringify({
        bookingId,
        workerId,
        tier,
        expiresAt: expiresAt.toISOString(),
      }),
      { EX: ttlSeconds }
    );

    const timer = setTimeout(() => {
      void this.expireOffer(bookingId, workerId);
    }, ttlSeconds * 1000);

    this.expirationTimers.set(bookingId, timer);

    return {
      bookingId,
      workerId,
      tier,
      expiresAt,
      status: "pending" as const,
    };
  }

  async getOffer(bookingId: number, workerId: number) {
    const offerKey = `booking:${bookingId}:offer:worker:${workerId}`; 

    const offer = await redis.hGetAll(offerKey);

    if (!offer.bookingId) {
      return null;
    }

    return {
      bookingId: Number(offer.bookingId),
      workerId: Number(offer.workerId),
      tier: offer.tier,
      expiresAt: new Date(offer.expiresAt),
      status: offer.status,
    };
  }

  async rejectOffer(
    bookingId: number,
    workerId: number
  ) {
    const offer = await this.getOffer(bookingId, workerId); 

    if (!offer) {
      return false;
    }

    if (offer.workerId !== workerId) {
      return false;
    }

    if (offer.status !== "pending") {
      return false;
    }

    await redis.hSet(
      `booking:${bookingId}:offer:worker:${workerId}`, 
      "status",
      "rejected"
    );

    await this.lockService.release(
      bookingId,
      workerId
    );

    return true;
  }

  private async expireOffer(
    bookingId: number,
    workerId: number
  ) {
    const offerKey = `booking:${bookingId}:offer:worker:${workerId}`; 
    const lockKey = `booking:${bookingId}:allocation:winner`; 

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
          "expired"
        )

        redis.call(
          "DEL",
          KEYS[2]
        )

        return 1
      `,
      {
        keys: [offerKey, lockKey],
        arguments: [workerId.toString()],
      }
    );

    if (result !== 1) {
      return false;
    }

    this.expirationTimers.delete(bookingId);

    console.log(
      `Allocation offer expired: booking=${bookingId}, worker=${workerId}`
    );

    return true;
  }
}
