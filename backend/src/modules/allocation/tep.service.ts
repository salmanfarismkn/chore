import { AllocationService } from "./allocation.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { BookingsRepository } from "../bookings/bookings.repository";
import type { AllocationTier } from "./allocation.types";

export class TepService {
  constructor(
    private readonly allocationService: AllocationService,
    private readonly offerService: AllocationOfferService,
    private readonly bookingsRepository: BookingsRepository
  ) {}

  async startAllocation(
    bookingId: number,
    serviceCategoryId: number
  ) {
    const tiers =
      await this.allocationService.createTiers(
        serviceCategoryId
      );

    if (tiers.length === 0) {
      return {
        allocated: false,
        reason: "no_workers_available",
      };
    }

    const firstTier = tiers[0];

    await this.sendTier(
      bookingId,
      firstTier
    );

    return {
      allocated: true,
      tier: firstTier.name,
    };
  }

  private async sendTier(
    bookingId: number,
    tier: AllocationTier
  ) {
    for (const candidate of tier.candidates) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        tier.name,
        tier.timeoutSeconds
      );
    }
  }
}