import { redis } from "../../config/redis";
import { AllocationLockService } from "./allocation-lock.service";

export class AllocationOfferService {
  constructor(
    private readonly lockService = new AllocationLockService()
  ) {}

  async createOffer(
    bookingId: number,
    workerId: number,
    tier: string,
    ttlSeconds: number
  ) {
    const acquired =
      await this.lockService.acquire(
        bookingId,
        workerId,
        ttlSeconds
      );

    if (!acquired) {
      return null;
    }

    const expiresAt = new Date(
      Date.now() + ttlSeconds * 1000
    );

    const offerKey =
      `booking:${bookingId}:offer`;

    await redis.hSet(offerKey, {
      bookingId: bookingId.toString(),
      workerId: workerId.toString(),
      tier,
      expiresAt: expiresAt.toISOString(),
      status: "pending",
    });

    await redis.expire(
      offerKey,
      ttlSeconds
    );

    return {
      bookingId,
      workerId,
      tier,
      expiresAt,
      status: "pending" as const,
    };
  }

  async getOffer(bookingId: number) {
    const offerKey =
      `booking:${bookingId}:offer`;

    const offer =
      await redis.hGetAll(offerKey);

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
    const offer =
      await this.getOffer(bookingId);

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
      `booking:${bookingId}:offer`,
      "status",
      "rejected"
    );

    await this.lockService.release(
      bookingId,
      workerId
    );

    return true;
  }
}