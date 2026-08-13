import { allocationWeights, allocationTiers } from "../../config/allocation";
import type { AllocationCandidate } from "./allocation.types";
import { AllocationRepository } from "./allocation.repository";

export class AllocationService {
  constructor(private readonly allocationRepository: AllocationRepository) {}

  private computeScore(candidate: Omit<AllocationCandidate, "score">): number {
    return (
      candidate.averageRating * allocationWeights.rating +
      candidate.completedJobs * allocationWeights.completedJobs
    );
  }

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

  async allocateWithTiers(serviceCategoryId: number): Promise<{
    tier1: (AllocationCandidate & { score: number })[];
    tier2: (AllocationCandidate & { score: number })[];
    tier3: (AllocationCandidate & { score: number })[];
    remaining: (AllocationCandidate & { score: number })[];
  }> {
    const rankedCandidates = await this.allocate(serviceCategoryId);

    const tier1 = rankedCandidates.slice(0, allocationTiers.tier1.candidateCount);
    const tier2 = rankedCandidates.slice(
      allocationTiers.tier1.candidateCount,
      allocationTiers.tier1.candidateCount + allocationTiers.tier2.candidateCount
    );
    const tier3 = rankedCandidates.slice(
      allocationTiers.tier1.candidateCount + allocationTiers.tier2.candidateCount,
      allocationTiers.tier1.candidateCount + allocationTiers.tier2.candidateCount + allocationTiers.tier3.candidateCount
    );
    const remaining = rankedCandidates.slice(
      allocationTiers.tier1.candidateCount + allocationTiers.tier2.candidateCount + allocationTiers.tier3.candidateCount
    );

    return {
      tier1,
      tier2,
      tier3,
      remaining,
    };
  }
}
