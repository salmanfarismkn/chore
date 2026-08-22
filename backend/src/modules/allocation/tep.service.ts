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
    const allocationStarted =
      await this.bookingsRepository.startAllocation(
        bookingId
      );

    if (!allocationStarted) {
      return {
        allocated: false,
        reason: "allocation_not_started",
      };
    }

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

    for (const candidate of firstTier.candidates) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        firstTier.name,
        firstTier.timeoutSeconds
      );
    }

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

  async advanceTier(bookingId: number) {
    const booking =
      await this.bookingsRepository.getAllocationState(
        bookingId
      );

    if (!booking) {
      return null;
    }

    if (booking.status !== "ALLOCATING") {
      return null;
    }

    const tiers =
      await this.allocationService.createTiers(
        booking.serviceCategoryId
      );

    const nextTierNumber =
      booking.allocationTier + 1;

    const nextTier =
      this.allocationService.getTier(
        tiers,
        nextTierNumber
      );

    if (!nextTier) {
      return {
        finished: true,
        reason: "no_more_candidates",
      };
    }

    const updated =
      await this.bookingsRepository
        .moveToNextAllocationTier(
          bookingId,
          nextTierNumber
        );

    if (!updated) {
      return null;
    }

    for (
      const candidate of nextTier.candidates
    ) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        nextTier.name,
        nextTier.timeoutSeconds
      );
    }

    return {
      finished: false,
      tier: nextTier.name,
    };
  }
}