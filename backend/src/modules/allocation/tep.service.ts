import { AllocationService } from "./allocation.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { BookingsRepository } from "../bookings/bookings.repository";
import type { AllocationTier } from "./allocation.types";
import { AllocationLockService } from "./allocation-lock.service";
import { AllocationLeaseService } from "./allocation-lease.service";
import { INSTANCE_ID } from "../../config/instance";
import {
  AllocationFence,
  AllocationFenceError,
} from "./allocation-fence";


const TIER_SIZES = [5, 10, 20];

function buildTiers<T>(items: T[], tierSizes: number[]): T[][] {
  const tiers: T[][] = [];
  let index = 0;

  for (const size of tierSizes) {
    if (index >= items.length) {
      break;
    }

    tiers.push(items.slice(index, index + size));
    index += size;
  }

  return tiers;
}

export class TepService {
  constructor(
    private readonly allocationService: AllocationService,
    private readonly offerService: AllocationOfferService,
    private readonly bookingsRepository: BookingsRepository,
    private readonly allocationLockService: AllocationLockService,
    private readonly allocationLeaseService: AllocationLeaseService
  ) {}

  async startAllocation(
      bookingId: number,
      serviceCategoryId: number
    ) {
      const allocationStarted =
        await this.bookingsRepository.startAllocation(bookingId);

      if (!allocationStarted) {
        return {
          allocated: false,
          reason: "allocation_not_started",
        };
      }

      const fence = await this.acquireInitialFence(
        bookingId,
        allocationStarted.allocationGeneration
      );

      if (!fence) {
        return {
          allocated: false,
          reason: "allocation_lease_unavailable",
        };
      }

      const heartbeat = this.startLeaseHeartbeat(fence);

      try {
        if (
          allocationStarted.pickupLatitude === null ||
          allocationStarted.pickupLongitude === null
        ) {
          return {
            allocated: false,
            reason: "missing_pickup_coordinates",
          };
        }

        const tiers = await this.allocationService.createTiers(
          serviceCategoryId,
          allocationStarted.pickupLatitude,
          allocationStarted.pickupLongitude
        );

        if (tiers.length === 0) {
          await this.bookingsRepository.markAllocationFailed(
            bookingId,
            fence.generation
          );

          return {
            allocated: false,
            reason: "no_workers_available",
          };
        }

        const firstTier = tiers[0];

        await this.offerService.setTierRemaining(
          bookingId,
          firstTier.name,
          firstTier.candidates.length,
          fence
        );

        for (const candidate of firstTier.candidates) {
          await this.offerService.createOffer(
            bookingId,
            candidate.workerId,
            firstTier.name,
            firstTier.timeoutSeconds,
            fence
          );
        }

        return {
          allocated: true,
          tier: firstTier.name,
        };
      } finally {
      
        clearInterval(heartbeat);
        await this.allocationLeaseService.release(
          bookingId,
          INSTANCE_ID,
          fence.generation
        );
      }
    }

  private async acquireInitialFence(
    bookingId: number,
    generation: number
  ): Promise<AllocationFence | null> {
    const acquired = await this.allocationLeaseService.acquire(
      bookingId,
      INSTANCE_ID,
      generation
    );

    if (!acquired) {
      return null;
    }

    return {
      bookingId,
      instanceId: INSTANCE_ID,
      generation,
      token: this.allocationLeaseService.getToken(INSTANCE_ID, generation),
    };
  }

  private async acquireFreshFence(
    bookingId: number,
    currentGeneration: number
  ): Promise<AllocationFence | null> {
    const acquired = await this.allocationLeaseService.acquire(
      bookingId,
      INSTANCE_ID,
      currentGeneration
    );

    if (!acquired) {
      return null;
    }

    const nextGeneration =
      await this.bookingsRepository.acquireAllocationGeneration(
        bookingId,
        currentGeneration
      );

    if (nextGeneration === null) {
      await this.allocationLeaseService.release(
        bookingId,
        INSTANCE_ID,
        currentGeneration
      );
      return null;
    }

    const updatedLease = await this.allocationLeaseService.updateGeneration(
      bookingId,
      INSTANCE_ID,
      currentGeneration,
      nextGeneration
    );

    if (!updatedLease) {
      return null;
    }

    return {
      bookingId,
      instanceId: INSTANCE_ID,
      generation: nextGeneration,
      token: this.allocationLeaseService.getToken(
        INSTANCE_ID,
        nextGeneration
      ),
    };
  }

  private startLeaseHeartbeat(
    fence: AllocationFence
  ) {
    const interval = setInterval(async () => {
      const renewed =
        await this.allocationLeaseService.renew(
          fence.bookingId,
          fence.instanceId,
          fence.generation
        );

      if (!renewed) {
        clearInterval(interval);
        console.warn(JSON.stringify({
          event: "allocation_lease_lost",
          bookingId: fence.bookingId,
          generation: fence.generation,
          reason: "lease_renewal_failed",
        }));
      }
    }, 20_000);

    return interval;
  }

  private async sendTier(
    bookingId: number,
    tier: AllocationTier,
    fence: AllocationFence
  ) {
    await this.offerService.setTierRemaining(
      bookingId,
      tier.name,
      tier.candidates.length,
      fence
    );

    for (const candidate of tier.candidates) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        tier.name,
        tier.timeoutSeconds,
        fence
      );
    }
  }


  private async startTier(
    bookingId: number,
    tier: number,
    fence: AllocationFence
  ): Promise<void> {
    const booking =
      await this.bookingsRepository.getAllocationState(
        bookingId
      );

    if (!booking) {
      await this.bookingsRepository.markAllocationFailed(
        bookingId,
        fence.generation
      );
      return;
    }

    if (
      booking.pickupLatitude === null ||
      booking.pickupLongitude === null
    ) {
      await this.bookingsRepository.markAllocationFailed(
        bookingId,
        fence.generation
      );
      return;
    }

    const tiers = await this.allocationService.createTiers(
      booking.serviceCategoryId,
      booking.pickupLatitude,
      booking.pickupLongitude
    );

    const tierInfo = this.allocationService.getTier(tiers, tier);
    const tierWorkers = tierInfo?.candidates ?? [];

    if (tierWorkers.length === 0) {
      await this.bookingsRepository.markAllocationFailed(
        bookingId,
        fence.generation
      );
      return;
    }

    const updated = await this.bookingsRepository.moveToNextAllocationTier(
      bookingId,
      tier,
      tier,
      fence.generation
    );

    if (!updated) {
      throw new AllocationFenceError(
        bookingId,
        fence.generation,
        "booking generation changed before tier progression"
      );
    }

    await this.offerService.setTierRemaining(
      bookingId,
      tierInfo!.name,
      tierWorkers.length,
      fence
    );

    for (const candidate of tierWorkers) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        tierInfo!.name,
        tierInfo!.timeoutSeconds,
        fence
      );
    }
  }

  async advanceTier(bookingId: number) {
    const booking = await this.bookingsRepository.getAllocationState(bookingId);
    if (!booking || booking.status !== "ALLOCATING") {
      return null;
    }

    const fence = await this.acquireFreshFence(
      bookingId,
      booking.allocationGeneration
    );
    if (!fence) return null;

    try {
      return await this.advanceTierOnce(bookingId, fence);
    } finally {
      await this.allocationLeaseService.release(
        bookingId,
        INSTANCE_ID,
        fence.generation
      );
    }
  }

  private async advanceTierOnce(
    bookingId: number,
    fence: AllocationFence
  ) {
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

    if (await this.offerService.hasActiveOffers(bookingId, booking.allocationTier)) {
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
      await this.bookingsRepository.markAllocationFailed(
        bookingId,
        fence.generation
      );
      return {
        finished: true,
        reason: "no_more_candidates",
      };
    }


    const updated =
      await this.bookingsRepository
        .moveToNextAllocationTier(
          bookingId,
          nextTierNumber,
          booking.allocationTier,
          fence.generation
        );

    if (!updated) {
      return null;
    }

   
    await this.offerService.setTierRemaining(
      bookingId,
      nextTier.name,
      nextTier.candidates.length,
      fence
    );

    for (
      const candidate of nextTier.candidates
    ) {
      await this.offerService.createOffer(
        bookingId,
        candidate.workerId,
        nextTier.name,
        nextTier.timeoutSeconds,
        fence
      );
    }

    return {
      finished: false,
      tier: nextTier.name,
    };
  }

  async resumeAllocation(
    bookingId: number,
    tier: number
  ): Promise<void> {
    const booking = await this.bookingsRepository.getAllocationState(bookingId);

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

    const fence = await this.acquireFreshFence(
      bookingId,
      booking.allocationGeneration
    );
    if (!fence) {
      return;
    }

    try {
      await this.startTier(bookingId, tier, fence);
    } finally {
      await this.allocationLeaseService.release(
        bookingId,
        INSTANCE_ID,
        fence.generation
      );
    }
  }
}
