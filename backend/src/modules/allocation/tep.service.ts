import { AllocationService } from "./allocation.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { BookingsRepository } from "../bookings/bookings.repository";
import type { AllocationTier } from "./allocation.types";
import { AllocationLockService } from "./allocation-lock.service";
import { redis } from "../../config/redis";

export class TepService {
  constructor(
    private readonly allocationService: AllocationService,
    private readonly offerService: AllocationOfferService,
    private readonly bookingsRepository: BookingsRepository,
    private readonly allocationLockService: AllocationLockService
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

    if (
      allocationStarted.pickupLatitude === null ||
      allocationStarted.pickupLongitude === null
    ) {
      return {
        allocated: false,
        reason: "missing_pickup_coordinates",
      };
    }

    const tiers =
      await this.allocationService.createTiers(
        serviceCategoryId,
        allocationStarted.pickupLatitude,
        allocationStarted.pickupLongitude
      );

    if (tiers.length === 0) {
      return {
        allocated: false,
        reason: "no_workers_available",
      };
    }

    const firstTier = tiers[0];

    const key = `allocation:booking:${bookingId}:tier:${firstTier.name}:remaining`;
    await redis.set(key, firstTier.candidates.length.toString());

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
    
    const key = `allocation:booking:${bookingId}:tier:${tier.name}:remaining`;
    await redis.set(key, tier.candidates.length.toString());

    for (const candidate of tier.candidates) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        tier.name,
        tier.timeoutSeconds
      );
    }
  }

  private async startTier(
    bookingId: number,
    tier: number
  ) {
    const booking =
      await this.bookingsRepository.getAllocationState(
        bookingId
      );

    if (!booking) {
      return;
    }

    if (booking.status !== "ALLOCATING") {
      return;
    }

    if (
      booking.pickupLatitude === null ||
      booking.pickupLongitude === null
    ) {
      await this.bookingsRepository.markAllocationFailed(bookingId);
      return;
    }

    const tiers = await this.allocationService.createTiers(
      booking.serviceCategoryId,
      booking.pickupLatitude,
      booking.pickupLongitude
    );

    const targetTier = this.allocationService.getTier(
      tiers,
      tier
    );

    if (!targetTier) {
      await this.bookingsRepository.markAllocationFailed(bookingId);
      return;
    }

    const updated =
      await this.bookingsRepository.moveToNextAllocationTier(
        bookingId,
        tier
      );

    if (!updated) {
      return;
    }

    await this.sendTier(bookingId, targetTier);
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

    if (
      booking.pickupLatitude === null ||
      booking.pickupLongitude === null
    ) {
      return null;
    }

    const tiers =
      await this.allocationService.createTiers(
        booking.serviceCategoryId,
        booking.pickupLatitude,
        booking.pickupLongitude
      );

    const nextTierNumber =
      booking.allocationTier + 1;

    const nextTier =
      this.allocationService.getTier(
        tiers,
        nextTierNumber
      );

    if (!nextTier) {
      await this.bookingsRepository.markAllocationFailed(bookingId);
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

   
    const key = `allocation:booking:${bookingId}:tier:${nextTier.name}:remaining`;
    await redis.set(key, nextTier.candidates.length.toString());

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

  private async advanceToNextTier(
    bookingId: number,
    completedTier: number
  ) {
    const booking = await this.bookingsRepository.getAllocationState(
      bookingId
    );

    if (!booking) return;

    if (booking.status !== "ALLOCATING") return;

    const winner = await this.allocationLockService.getWinner(
      bookingId
    );

    if (winner !== null) return;

    const nextTierNumber = completedTier + 1;

    if (
      booking.pickupLatitude === null ||
      booking.pickupLongitude === null
    ) {
      await this.bookingsRepository.markAllocationFailed(bookingId);
      return;
    }

    const tiers = await this.allocationService.createTiers(
      booking.serviceCategoryId,
      booking.pickupLatitude,
      booking.pickupLongitude
    );

    const nextTier =
      this.allocationService.getTier(
        tiers,
        nextTierNumber
      );

    if (!nextTier) {
      await this.bookingsRepository.markAllocationFailed(bookingId);
      return;
    }

    const updated = await this.bookingsRepository.moveToNextAllocationTier(
      bookingId,
      nextTierNumber
    );

    if (!updated) return;

    await this.sendTier(bookingId, nextTier);
  }

  async resumeAllocation(
    bookingId: number,
    tier: number
  ): Promise<void> {
    const booking = await (this.bookingsRepository as any).getBooking(
          bookingId
        );

    if (!booking) {
      return;
    }

    if (booking.status !== "ALLOCATING") {
      return;
    }

    const winner =
      await this.allocationLockService.getWinner(bookingId);

    if (winner !== null) {
      return;
    }

    await this.startTier(bookingId, tier);
  }
}
