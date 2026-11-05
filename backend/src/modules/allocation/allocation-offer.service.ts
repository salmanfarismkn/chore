import { redis } from "../../config/redis";
import { db } from "../../db";
import { bookings, workerProfiles } from "../../db/schema";
import { eq } from "drizzle-orm";
import { emitWorkerOffer } from "../../realtime/allocation-events";
import { AllocationLockService } from "./allocation-lock.service";
import { AllocationFence, AllocationFenceError } from "./allocation-fence";

const PENDING_OFFERS_INDEX = "allocation:offers:pending";

type ReconciliationStatus =
  | "ALLOCATING"
  | "ASSIGNED"
  | "COMPLETED"
  | "CANCELLED"
  | "ALLOCATION_FAILED";

export class AllocationOfferService {
  constructor(
    private readonly lockService = new AllocationLockService(),
    private expirationTimers = new Map<number, NodeJS.Timeout>()
  ) {}

  async createOffer(
    bookingId: number,
    userId: number,   
    tier: string,
    ttlSeconds: number,
    fence?: AllocationFence
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
    const [booking] = await db
      .select({ allocationGeneration: bookings.allocationGeneration })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1);
    const generation = fence?.generation ?? booking?.allocationGeneration;

    if (generation === undefined) {
      return {
        bookingId,
        userId,
        tier,
        status: "unavailable" as const,
        reason: "booking_not_found",
      };
    }

    const expiresAt = new Date(
      Date.now() + ttlSeconds * 1000
    );

    if (fence) {
      const written = await redis.eval(
        `
        if redis.call("GET", KEYS[1]) ~= ARGV[1] then
          return 0
        end
        redis.call("HSET", KEYS[2],
          "bookingId", ARGV[2],
          "workerId", ARGV[3],
          "tier", ARGV[4],
          "expiresAt", ARGV[5],
          "generation", ARGV[6],
          "status", "pending")
        redis.call("SADD", KEYS[3], KEYS[2])
        redis.call("SADD", KEYS[4], KEYS[2])
        redis.call("SADD", KEYS[5], KEYS[2])
        redis.call("EXPIRE", KEYS[2], ARGV[7])
        return 1
        `,
        {
          keys: [
            `booking:${bookingId}:allocation:lease`,
            offerKey,
            `booking:${bookingId}:allocation:offers`,
            PENDING_OFFERS_INDEX,
            `worker:${userId}:offers:pending`,
          ],
          arguments: [
            fence.token,
            bookingId.toString(),
            userId.toString(),
            tier,
            expiresAt.getTime().toString(),
            fence.generation.toString(),
            ttlSeconds.toString(),
          ],
        }
      );

      if (written !== 1) {
        throw new AllocationFenceError(
          bookingId,
          fence.generation,
          "lease ownership changed before offer creation"
        );
      }
    } else {
      await redis.hSet(offerKey, {
        bookingId: bookingId.toString(),
        workerId: userId.toString(),
        tier,
        expiresAt: expiresAt.getTime().toString(),
        generation: generation.toString(),
        status: "pending",
      });

      await redis.sAdd(
        `booking:${bookingId}:allocation:offers`,
        offerKey
      );
      await redis.sAdd(PENDING_OFFERS_INDEX, offerKey);
      await redis.sAdd(`worker:${userId}:offers:pending`, offerKey);
    }
    
    emitWorkerOffer({
      bookingId,
      offerId: offerKey,
      workerId: userId,
      tier,
      expiresAt: expiresAt.getTime(),
      generation,
    });
    
    if (!fence) {
      await redis.expire(offerKey, ttlSeconds);
    }

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
      generation: offer.generation ? Number(offer.generation) : undefined,
    };
  }

  async setTierRemaining(
    bookingId: number,
    tier: string,
    count: number,
    fence: AllocationFence
  ): Promise<void> {
    const result = await redis.eval(
      `
      if redis.call("GET", KEYS[1]) ~= ARGV[1] then
        return 0
      end
      redis.call("SET", KEYS[2], ARGV[2])
      return 1
      `,
      {
        keys: [
          `booking:${bookingId}:allocation:lease`,
          `allocation:booking:${bookingId}:tier:${tier}:generation:${fence.generation}:remaining`,
        ],
        arguments: [fence.token, count.toString()],
      }
    );

    if (result !== 1) {
      throw new AllocationFenceError(
        bookingId,
        fence.generation,
        "lease ownership changed before tier state mutation"
      );
    }
  }

  async reconcileBooking(
        bookingId: number,
        generation: number,
        status: ReconciliationStatus
      ): Promise<boolean> {
        const offersKey = `booking:${bookingId}:allocation:offers`;
        const indexedOfferKeys = await redis.sMembers(offersKey);
        const discoveredOfferKeys: string[] = [];
        for await (const batch of redis.scanIterator({
          MATCH: `booking:${bookingId}:offer:*`,
          COUNT: 100,
        })) {
          discoveredOfferKeys.push(...batch);
        }
        const offerKeys = [
          ...new Set([...indexedOfferKeys, ...discoveredOfferKeys]),
        ];

        for (const offerKey of offerKeys) {
          const offer = await redis.hGetAll(offerKey);
          if (!offer.bookingId) {
            await redis.sRem(PENDING_OFFERS_INDEX, offerKey);
            await redis.sRem(offersKey, offerKey);
            continue;
          }
          if (Number(offer.generation) !== generation) {
            continue;
          }

          const workerId = Number(offer.workerId);
          const result = await redis.eval(
            `
            local offerGeneration = redis.call("HGET", KEYS[1], "generation")
            if offerGeneration ~= ARGV[1] then
              return 0
            end

            if ARGV[2] == "ALLOCATING" then
              local lease = redis.call("GET", KEYS[3])
              if lease then
                return 0
              end
              if redis.call("HGET", KEYS[1], "status") == "accepted" then
                redis.call("HSET", KEYS[1], "status", "pending")
                redis.call("SADD", KEYS[6], KEYS[1])
                redis.call("SADD", KEYS[7], KEYS[1])
                if redis.call("GET", KEYS[2]) == ARGV[4] then
                  redis.call("DEL", KEYS[2])
                end
                return 1
              end
              return 0
            end

            redis.call("DEL", KEYS[1])
            redis.call("SREM", KEYS[4], KEYS[1])
            redis.call("SREM", KEYS[6], KEYS[1])
            redis.call("SREM", KEYS[7], KEYS[1])
            if redis.call("GET", KEYS[2]) == ARGV[4] then
              redis.call("DEL", KEYS[2])
            end
            local lease = redis.call("GET", KEYS[3])
            if lease and string.sub(lease, -string.len(":" .. ARGV[1])) == ":" .. ARGV[1] then
              redis.call("DEL", KEYS[3])
            end
            redis.call("DEL", KEYS[5])
            return 1
            `,
            {
              keys: [
                offerKey,
                `booking:${bookingId}:allocation:winner`,
                `booking:${bookingId}:allocation:lease`,
                offersKey,
                `allocation:booking:${bookingId}:tier:${offer.tier}:generation:${generation}:remaining`,
                PENDING_OFFERS_INDEX,
                `worker:${workerId}:offers:pending`,
              ],
              arguments: [
                generation.toString(),
                status,
                workerId.toString(),
                `${workerId}:${generation}`,
              ],
            }
          );

          if (status === "ALLOCATING" && result === 1) {
            return true;
          }
        }

        if (status !== "ALLOCATING") {
          await redis.eval(
            `
            local winner = redis.call("GET", KEYS[1])
            if winner and string.sub(winner, -string.len(":" .. ARGV[1])) == ":" .. ARGV[1] then
              redis.call("DEL", KEYS[1])
            end
            local lease = redis.call("GET", KEYS[2])
            if lease and string.sub(lease, -string.len(":" .. ARGV[1])) == ":" .. ARGV[1] then
              redis.call("DEL", KEYS[2])
            end
            return 1
            `,
            {
              keys: [
                `booking:${bookingId}:allocation:winner`,
                `booking:${bookingId}:allocation:lease`,
              ],
              arguments: [generation.toString()],
            }
          );
          const counterKeys: string[] = [];
          for await (const batch of redis.scanIterator({
            MATCH: `allocation:booking:${bookingId}:tier:*:generation:${generation}:remaining`,
            COUNT: 100,
          })) {
            counterKeys.push(...batch);
          }
          for (const counterKey of counterKeys) {
            await redis.del(counterKey);
          }
        }

        return status !== "ALLOCATING";
  }

  async revokeWorkerOffers(workerId: number): Promise<number> {
    const offerKeys = await redis.sMembers(
      `worker:${workerId}:offers:pending`
    );
    let revoked = 0;

    for (const offerKey of offerKeys) {
      const offer = await redis.hGetAll(offerKey);
      if (!offer.bookingId || !offer.workerId) {
        await redis.sRem(`worker:${workerId}:offers:pending`, offerKey);
        await redis.sRem(PENDING_OFFERS_INDEX, offerKey);
        continue;
      }
      const bookingId = Number(offer.bookingId);
      const offersKey = `booking:${bookingId}:allocation:offers`;
      const [booking] = await db
        .select({
          status: bookings.status,
          allocationGeneration: bookings.allocationGeneration,
        })
        .from(bookings)
        .where(eq(bookings.id, bookingId))
        .limit(1);

      if (!booking || booking.status !== "ALLOCATING") {
        await redis.sRem(`worker:${workerId}:offers:pending`, offerKey);
        await redis.sRem(PENDING_OFFERS_INDEX, offerKey);
        continue;
      }

      const result = await redis.eval(
          `
          if redis.call("HGET", KEYS[1], "workerId") ~= ARGV[1] then
            return 0
          end
          if redis.call("HGET", KEYS[1], "status") ~= "pending" then
            return 0
          end
          if redis.call("HGET", KEYS[1], "generation") ~= ARGV[2] then
            return 0
          end
          redis.call("HSET", KEYS[1], "status", "rejected")
          redis.call("SREM", KEYS[2], KEYS[1])
          redis.call("SREM", KEYS[3], KEYS[1])
          redis.call("SREM", KEYS[4], KEYS[1])
          return 1
          `,
          {
            keys: [
              offerKey,
              offersKey,
              PENDING_OFFERS_INDEX,
              `worker:${workerId}:offers:pending`,
            ],
            arguments: [
              workerId.toString(),
              booking.allocationGeneration.toString(),
            ],
          }
        );

      if (result === 1) {
        revoked += 1;
      }
    }

    return revoked;
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

    const offerKey = `booking:${bookingId}:offer:${workerId}`;
    await redis.hSet(
      offerKey,
      "status",
      "rejected"
    );

    await redis.sRem(PENDING_OFFERS_INDEX, offerKey);
    await redis.sRem(`worker:${workerId}:offers:pending`, offerKey);
    await redis.sRem(`booking:${bookingId}:allocation:offers`, offerKey);
    await this.lockService.releaseWinner(bookingId, workerId);

    return true;
  }

  private async expireOffer(
    bookingId: number,
    workerId: number,
    generation: number
  ) {
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

        if redis.call("HGET", KEYS[1], "generation") ~= ARGV[2] then
          return 0
        end

        if lockWorker and lockWorker ~= ARGV[1] then
          return 0
        end

        redis.call("HSET", KEYS[1], "status", "expired")
        redis.call("SREM", KEYS[3], KEYS[1])
        redis.call("SREM", KEYS[4], KEYS[1])
        redis.call("SREM", KEYS[5], KEYS[1])

        if lockWorker == ARGV[1] then
          redis.call("DEL", KEYS[2])
        end

        return 1
      `,
      {
        keys: [
          offerKey,
          lockKey,
          PENDING_OFFERS_INDEX,
          `worker:${workerId}:offers:pending`,
          `booking:${bookingId}:allocation:offers`,
        ],
        arguments: [workerId.toString(), generation.toString()],
      }
    );

    if (result !== 1) {
      return false;
    }

    this.expirationTimers.delete(bookingId);

    return true;
  }

  async hasActiveOffers(
    bookingId: number,
    tier: number
  ): Promise<boolean> {
    const offerKeys = await redis.sMembers(
      `booking:${bookingId}:allocation:offers`
    );

    for (const offerKey of offerKeys) {
      const offer = await redis.hGetAll(offerKey);

      if (
        offer.status === "pending" &&
        (offer.tier === String(tier) || offer.tier === `tier_${tier}`)
      ) {
        return true;
      }

      if (offer.status !== "pending") {
        await redis.sRem(
          `booking:${bookingId}:allocation:offers`,
          offerKey
        );
        const workerId = Number(offer.workerId);
        await redis.sRem(PENDING_OFFERS_INDEX, offerKey);
        await redis.sRem(`worker:${workerId}:offers:pending`, offerKey);
      }
    }

    return false;
  }

  async expirePendingOffers(): Promise<Set<number>> {
    const expiredBookings = new Set<number>();
    const keys = await redis.sMembers(PENDING_OFFERS_INDEX);

    for (const offerKey of keys) {
      const offer = await redis.hGetAll(offerKey);
      if (offer.status !== "pending" || Number(offer.expiresAt) > Date.now()) {
        continue;
      }

      const [, bookingIdValue, , workerIdValue] = offerKey.split(":");
      const bookingId = Number(bookingIdValue);
      const workerId = Number(workerIdValue);
      const generation = Number(offer.generation);
      const expired = await this.expireOffer(
        bookingId,
        workerId,
        generation
      );

      if (expired) {
        expiredBookings.add(bookingId);
        await redis.sRem(
          `booking:${bookingId}:allocation:offers`,
          offerKey
        );
      }
    }

    return expiredBookings;
  }
}
