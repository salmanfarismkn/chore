import { allocationWeights, allocationConfig } from "../../config/allocation";
import type { AllocationCandidate } from "./allocation.types";
import { AllocationRepository } from "./allocation.repository";
import { AllocationLockService } from "./allocation-lock.service";


export interface AllocationTier {
  name: string;
  candidates: (AllocationCandidate & { score: number })[];
  timeoutSeconds: number;
}

export class AllocationService {
  constructor(private readonly allocationRepository: AllocationRepository) {}

  private computeScore(candidate: Omit<AllocationCandidate, "score">): number {
    return (
      candidate.averageRating * allocationWeights.rating +
      candidate.completedJobs * allocationWeights.completedJobs
    );
  }
  private lockService = new AllocationLockService();

  async allocate(serviceCategoryId: number): Promise<(AllocationCandidate & { score: number })[]> {
    const candidates = await this.allocationRepository.findCandidates(serviceCategoryId);

    return candidates
      .map(c => {
        const averageRating = c.averageRating ?? 0;
        const completedJobs = c.completedJobs ?? 0;
        const candidate: Omit<AllocationCandidate, "score"> = {
          ...c,
          averageRating,
          completedJobs,
        };

        return {
          ...candidate,
          score: this.computeScore(candidate),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  async createTiers(serviceCategoryId: number): Promise<AllocationTier[]> {
    const candidates = await this.allocate(serviceCategoryId);

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
    currentTierIndex: number
  ) {
    const tiers =
      await this.createTiers(
        serviceCategoryId
      );

    const nextTier =
      tiers[currentTierIndex + 1];

    if (!nextTier) {
      return null;
    }

    return nextTier;
  }
}
