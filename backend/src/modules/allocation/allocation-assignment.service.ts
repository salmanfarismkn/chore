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
    // Step 1: Try to accept via Redis lock
    const accepted = await this.acceptanceService.accept(
      bookingId,
      workerId
    );

    if (!accepted) {
      return null;
    }

    // Step 2: Assign worker in PostgreSQL
    const booking = await this.bookingsRepository.assignWorker(
      bookingId,
      workerId
    );

    if (!booking) {
      return null;
    }

    await this.acceptanceService.releaseLock(
      bookingId,
      workerId
    );

    return booking;
  }
}
