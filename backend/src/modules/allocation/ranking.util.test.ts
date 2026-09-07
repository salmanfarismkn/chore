import {
  calculateDistanceScore,
  calculateRatingScore,
  calculateExperienceScore,
  calculateWorkloadScore,
  calculateWorkerScore,
  rankWorkers,
} from "./ranking.util";

import { describe, it, expect } from "vitest";

describe("calculateDistanceScore", () => {
  it("gives the best score to a nearby worker", () => {
    expect(calculateDistanceScore(0)).toBe(1);
  });

  it("gives a middle score at 5 km", () => {
    expect(calculateDistanceScore(5)).toBeCloseTo(0.5);
  });

  it("gives zero score at or beyond 10 km", () => {
    expect(calculateDistanceScore(10)).toBe(0);
    expect(calculateDistanceScore(15)).toBe(0);
  });
});

describe("calculateRatingScore", () => {
  it("normalizes rating from 0 to 5", () => {
    expect(calculateRatingScore(0)).toBe(0);
    expect(calculateRatingScore(2.5)).toBeCloseTo(0.5);
    expect(calculateRatingScore(5)).toBe(1);
  });
});

describe("calculateExperienceScore", () => {
  it("normalizes completed jobs", () => {
    expect(calculateExperienceScore(0)).toBe(0);
    expect(calculateExperienceScore(250)).toBeCloseTo(0.5);
    expect(calculateExperienceScore(500)).toBe(1);
  });

  it("caps experience at the maximum", () => {
    expect(calculateExperienceScore(1000)).toBe(1);
  });
});

describe("calculateWorkloadScore", () => {
  it("gives the best score to workers with no active jobs", () => {
    expect(calculateWorkloadScore(0)).toBe(1);
  });

  it("decreases as workload increases", () => {
    expect(calculateWorkloadScore(1)).toBeCloseTo(0.8);
    expect(calculateWorkloadScore(2)).toBeCloseTo(0.6);
    expect(calculateWorkloadScore(5)).toBe(0);
  });

  it("does not become negative", () => {
    expect(calculateWorkloadScore(10)).toBe(0);
  });
});

describe("calculateWorkerScore", () => {
  it("calculates a combined worker score", () => {
    const result = calculateWorkerScore({
      distanceKm: 0,
      rating: 5,
      completedJobs: 500,
      activeJobs: 0,
    });

    expect(result.distanceScore).toBe(1);
    expect(result.ratingScore).toBe(1);
    expect(result.experienceScore).toBe(1);
    expect(result.workloadScore).toBe(1);
    expect(result.totalScore).toBeCloseTo(1);
  });

  it("produces a score between 0 and 1", () => {
    const result = calculateWorkerScore({
      distanceKm: 5,
      rating: 2.5,
      completedJobs: 250,
      activeJobs: 2,
    });

    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(1);
  });
});

describe("rankWorkers", () => {
  it("ranks workers from highest score to lowest", () => {
    const result = rankWorkers([
      {
        workerId: 1,
        distanceKm: 8,
        rating: 4,
        completedJobs: 50,
        activeJobs: 2,
      },
      {
        workerId: 2,
        distanceKm: 1,
        rating: 5,
        completedJobs: 300,
        activeJobs: 0,
      },
    ]);

    expect(result[0].workerId).toBe(2);
    expect(result[1].workerId).toBe(1);
  });
});