import { allocationWeights } from "../../config/allocation";
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
}
