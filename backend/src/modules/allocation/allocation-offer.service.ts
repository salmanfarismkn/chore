import { redis } from "../../config/redis";
import { db } from "../../db";
import { workerProfiles } from "../../db/schema";
import { eq } from "drizzle-orm";
import { emitWorkerOffer } from "../../realtime/allocation-events";
import { AllocationLockService } from "./allocation-lock.service";

export class AllocationOfferService {
  constructor(
    private readonly lockService = new AllocationLockService(),
    private expirationTimers = new Map<number, NodeJS.Timeout>()
  ) {}

  async createOffer(
    bookingId: number,
    userId: number,   
    tier: string,
    ttlSeconds: number
  ) {
    if (!userId) {
      return {
        bookingId,
        tier,
        status: "failed" as const,
        reason: "missing_user_id",
      };
    }


    const worker = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.userId, userId))
      .limit(1);


    if (!worker.length || worker[0].status !== "available") {
      return {
        bookingId,
        userId,
        tier,
        status: "unavailable" as const,
        reason: !worker.length ? "not_a_worker" : "worker_not_available",
      };
    }
    const offerKey = `booking:${bookingId}:offer:${userId}`;

    const expiresAt = new Date(
      Date.now() + ttlSeconds * 1000
    );

    await redis.hSet(offerKey, {
      bookingId: bookingId.toString(),
      workerId: userId.toString(),
      tier,
      expiresAt: expiresAt.getTime().toString(),
      status: "pending",
    });
    
    emitWorkerOffer({
      bookingId,
      workerId: userId,
      tier,
      expiresAt: expiresAt.getTime(),
    });
    
    await redis.expire(offerKey, ttlSeconds);

    return {
      bookingId,
      userId,
      tier,
      expiresAt,
      status: "pending" as const,
    };
  }

  async getOffer(bookingId: number, workerId: number) {
    const offerKey = `booking:${bookingId}:offer:${workerId}`;

    const offer = await redis.hGetAll(offerKey);

    if (!offer.bookingId) {
      return null;
    }

    return {
      bookingId: Number(offer.bookingId),
      workerId: Number(offer.workerId),
      tier: offer.tier,
      expiresAt: new Date(Number(offer.expiresAt)),
      status: offer.status,
    };
  }

  async rejectOffer(bookingId: number, workerId: number) {
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
      `booking:${bookingId}:offer:${workerId}`,
      "status",
      "rejected"
    );

    await this.lockService.releaseWinner(bookingId, workerId);

    return true;
  }

  private async expireOffer(bookingId: number, workerId: number) {
    const offerKey = `booking:${bookingId}:offer:${workerId}`;
    const lockKey = `booking:${bookingId}:allocation:winner`;

    const result = await redis.eval(
      `
        local offerWorker = redis.call("HGET", KEYS[1], "workerId")
        local status = redis.call("HGET", KEYS[1], "status")
        local lockWorker = redis.call("GET", KEYS[2])

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

        redis.call("HSET", KEYS[1], "status", "expired")
        redis.call("DEL", KEYS[2])

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

  async hasActiveOffers(
    bookingId: number,
    tier: number
  ): Promise<boolean> {
    const key =
      `allocation:booking:${bookingId}:tier:${tier}:offers`;

    const offerKeys = await redis.sMembers(key);

    for (const offerKey of offerKeys) {
      const offer = await redis.hGetAll(offerKey);

      if (offer.status === "pending") {
        return true;
      }

      await redis.sRem(key, offerKey);
    }

    return false;
  }
}
