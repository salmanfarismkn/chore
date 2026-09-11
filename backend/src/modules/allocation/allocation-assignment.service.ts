import { NotFoundError } from "../../shared/core/errors/not-found-error";
import { BookingsRepository } from "../bookings/bookings.repository";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";

export class AllocationAssignmentService {
  constructor(
    private readonly bookingsRepository: BookingsRepository,
    private readonly acceptanceService: AllocationAcceptanceService
  ) {}

  async acceptOffer(
    bookingId: number,
    workerId: number
  ) {
    // 1. Atomically claim the offer/winner in Redis.
    const accepted =
      await this.acceptanceService.accept(
        bookingId,
        workerId
      );

    if (!accepted) {
      return null;
    }

    try {
      // 2. PostgreSQL is the final source of truth.
      const booking =
        await this.bookingsRepository.assignWorker(
          bookingId,
          workerId
        );

      if (!booking) {
        await this.acceptanceService.releaseWinner(
          bookingId,
          workerId
        );

        return null;
      }

      // 3. Assignment succeeded.
      await this.acceptanceService.releaseWinner(
        bookingId,
        workerId
      );

      return booking;
    } catch (error) {
      await this.acceptanceService.releaseWinner(
        bookingId,
        workerId
      );

      throw error;
    }
  }
}
