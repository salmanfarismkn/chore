import { BookingsRepository } from "../bookings/bookings.repository";
import { AllocationLockService } from "./allocation-lock.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { TepService } from "./tep.service";

export class AllocationRecoveryService {
  constructor(
    private readonly bookingsRepository: BookingsRepository,
    private readonly allocationLockService: AllocationLockService,
    private readonly allocationOfferService: AllocationOfferService,
    private readonly tepService: TepService
  ) {}

  async recoverBooking(bookingId: number): Promise<void> {
    const booking = await (this.bookingsRepository as any).getBooking(
      bookingId
    );

    if (!booking) {
      return;
    }

    if (booking.status !== "allocating") {
      return;
    }

    const winner =
      await this.allocationLockService.getWinner(bookingId);

    if (winner !== null) {
      return;
    }

    const hasActiveOffers =
      await this.allocationOfferService.hasActiveOffers(
        bookingId,
        booking.allocationTier
      );

    if (hasActiveOffers) {
      return;
    }

    await this.tepService.resumeAllocation(
      bookingId,
      booking.allocationTier
    );
  }
}