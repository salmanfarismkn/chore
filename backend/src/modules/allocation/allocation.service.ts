import { allocationWeights, allocationConfig } from "../../config/allocation";
import type { AllocationCandidate } from "./allocation.types";
import { AllocationRepository } from "./allocation.repository";
import { AllocationLockService } from "./allocation-lock.service";
import { BookingsRepository } from "../bookings/bookings.repository";
import { calculateDistanceKm } from "./distance.util";


export interface AllocationTier {
  name: string;
  candidates: (AllocationCandidate & { score: number })[];
  timeoutSeconds: number;
}

export class AllocationService {
  constructor(
    private readonly allocationRepository: AllocationRepository,
    private readonly bookingsRepository: BookingsRepository
  ) {}

  private computeScore(candidate: Omit<AllocationCandidate, "score">): number {
    return (
      candidate.averageRating * allocationWeights.rating +
      candidate.completedJobs * allocationWeights.completedJobs
    );
  }
  private lockService = new AllocationLockService();

  async allocate(
    serviceCategoryId: number,
    pickupLatitude: number,
    pickupLongitude: number
  ): Promise<(AllocationCandidate & { score: number })[]> {
    const candidates = await this.allocationRepository.findCandidates(serviceCategoryId);
    const workerIds = candidates.map(
      (candidate) => candidate.workerId
    );

    const workloadMap =
      await this.allocationRepository.getWorkerActiveJobCounts(
        workerIds
      );
    return candidates
      .flatMap(c => {
        if (c.latitude === null || c.longitude === null) {
          return [];
        }

        const latitude = c.latitude;
        const longitude = c.longitude;
        const activeJobs = workloadMap.get(c.workerId) ?? 0;
        const averageRating = c.averageRating ?? 0;
        const completedJobs = c.completedJobs ?? 0;
        const candidate: Omit<AllocationCandidate, "score"> = {
          ...c,
          latitude,
          longitude,
          averageRating,
          completedJobs,
          distanceKm: 0,
        };
        const distanceKm = calculateDistanceKm(
          pickupLatitude,
          pickupLongitude,
          candidate.latitude,
          candidate.longitude
        );
        
        return {
          ...candidate,
          distanceKm,
          activeJobs,
          score: this.computeScore(candidate),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  async createTiers(
    serviceCategoryId: number,
    pickupLatitude: number,
    pickupLongitude: number
  ): Promise<AllocationTier[]> {
    const candidates = await this.allocate(
      serviceCategoryId,
      pickupLatitude,
      pickupLongitude
    );

    const tiers: AllocationTier[] = [];
    let startIndex = 0;

    for (const config of allocationConfig.tiers) {
      const tierCandidates = candidates.slice(
        startIndex,
        startIndex + config.candidateCount
      );

      if (tierCandidates.length === 0) {
        break;
      }

      tiers.push({
        name: config.name,
        candidates: tierCandidates,
        timeoutSeconds: config.timeoutSeconds,
      });

      startIndex += config.candidateCount;
    }

    return tiers;
  }

  getTier(tiers: AllocationTier[], tierNumber: number): AllocationTier | null {
    return tiers[tierNumber - 1] ?? null;
  }

  async createOffer(bookingId: number, workerId: number, tier: number, ttlSeconds: number) {
    const acquired = await this.lockService.acquire(bookingId, workerId, ttlSeconds);

    if (!acquired) {
      return { message: "Offer could not be created", status: "failed" };
    }

    return {
      bookingId,
      workerId,
      tier,
      status: "pending",
      ttl: ttlSeconds,
      message: "Offer created"
    };
  }

  async moveToNextTier(
    bookingId: number,
    serviceCategoryId: number,
    currentTierIndex: number,
    pickupLatitude: number,
    pickupLongitude: number
  ) {
    const tiers =
      await this.createTiers(
        serviceCategoryId,
        pickupLatitude,
        pickupLongitude
      );

    const nextTier =
      tiers[currentTierIndex + 1];

    if (!nextTier) {
      return null;
    }

    return nextTier;
  }

  async startAllocation(bookingId: number) {
    const booking = await this.bookingsRepository.startAllocation(bookingId);

    if (!booking) {
      return {
        allocated: false,
        reason: "allocation_not_started",
      };
    }

    return {
      allocated: true,
      booking,
    };
  }
}

