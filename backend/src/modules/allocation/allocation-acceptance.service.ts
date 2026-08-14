import { redis } from "../../config/redis";
import { AllocationLockService } from "./allocation-lock.service";

export class AllocationAcceptanceService {
  constructor(
    private readonly lockService =
      new AllocationLockService()
  ) {}

  async accept(
    bookingId: number,
    workerId: number
  ): Promise<boolean> {
    const offerKey =
      `booking:${bookingId}:offer`;

    const offer =
      await redis.hGetAll(offerKey);

    if (!offer.bookingId) {
      return false;
    }

    if (
      Number(offer.workerId) !== workerId
    ) {
      return false;
    }

    if (offer.status !== "pending") {
      return false;
    }

    const expiresAt =
      new Date(offer.expiresAt);

    if (expiresAt.getTime() <= Date.now()) {
      return false;
    }

    const lockWorker =
      await this.lockService.getWorker(
        bookingId
      );

    if (lockWorker !== workerId) {
      return false;
    }

    await redis.hSet(
      offerKey,
      "status",
      "accepted"
    );

    return true;
  }
}