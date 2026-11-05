import { BookingsRepository } from "../bookings/bookings.repository";
import { AllocationOfferService } from "./allocation-offer.service";

export class AllocationReconciliationService {
  constructor(
    private readonly bookingsRepository: BookingsRepository,
    private readonly allocationOfferService: AllocationOfferService
  ) {}

  async reconcileBooking(bookingId: number): Promise<boolean> {
    const booking =
      await this.bookingsRepository.getAllocationState(bookingId);

    if (!booking) {
      return true;
    }

    const status =
      booking.status === "ALLOCATING"
        ? "ALLOCATING"
        : booking.status === "ASSIGNED" ||
            booking.status === "COMPLETED" ||
            booking.status === "CANCELLED" ||
            booking.status === "ALLOCATION_FAILED"
          ? booking.status
          : null;

    if (!status) {
      return false;
    }

    const repaired = await this.allocationOfferService.reconcileBooking(
      bookingId,
      booking.allocationGeneration,
      status
    );

    if (
      repaired &&
      booking.allocationReconciliationPending &&
      status !== "ALLOCATING"
    ) {
      await this.bookingsRepository.clearAllocationReconciliation(
        bookingId,
        booking.allocationGeneration
      );
    }

    return repaired;
  }
}
