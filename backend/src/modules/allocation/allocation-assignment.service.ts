import { BookingsRepository } from "../bookings/bookings.repository";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";

export class AllocationAssignmentService {
  constructor(
    private readonly bookingsRepository: BookingsRepository,
    private readonly acceptanceService: AllocationAcceptanceService
  ) {}

  async acceptOffer(
    bookingId: number,
    workerId: number,
    generation?: number
  ) {
    // 1. Atomically claim the offer/winner in Redis.
    const accepted =
      await this.acceptanceService.accept(
        bookingId,
        workerId,
        generation
      );

    if (!accepted) {
      return null;
    }

    try {
      // 2. PostgreSQL is the final source of truth.
      const booking =
        await this.bookingsRepository.assignWorker(
          bookingId,
          workerId,
          generation
        );

      if (!booking) {
        const currentState =
          await this.bookingsRepository.getAllocationState(bookingId);

        if (
          currentState?.status === "ALLOCATING" &&
          currentState.allocationGeneration === generation
        ) {
          await this.acceptanceService.rollbackAcceptance(
            bookingId,
            workerId,
            generation
          );
        }

        return null;
      }

      // 3. Assignment succeeded.
      try {
        await this.acceptanceService.releaseWinner(
          bookingId,
          workerId,
          generation
        );
      } catch (cleanupError) {
        console.error(JSON.stringify({
          event: "allocation_redis_cleanup_failed",
          bookingId,
          generation,
          reason: cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        }));
      }

      return booking;
    } catch (error) {
      const currentState =
        await this.bookingsRepository.getAllocationState(bookingId);

      if (
        currentState?.status === "ALLOCATING" &&
        currentState.allocationGeneration === generation
      ) {
        await this.acceptanceService.rollbackAcceptance(
          bookingId,
          workerId,
          generation
        );
      }

      throw error;
    }
  }
}
