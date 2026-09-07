const MAX_DISTANCE_KM = 10;
const MAX_COMPLETED_JOBS = 500;
const MAX_ACTIVE_JOBS = 5;

function normalize(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

const DISTANCE_WEIGHT = 0.5;
const RATING_WEIGHT = 0.25;
const EXPERIENCE_WEIGHT = 0.15;
const WORKLOAD_WEIGHT = 0.1;

export function calculateDistanceScore(distanceKm: number): number {
  return 1 - normalize(distanceKm, 0, MAX_DISTANCE_KM);
}

export function calculateRatingScore(rating: number): number {
  return normalize(rating, 0, 5);
}

export function calculateExperienceScore(
  completedJobs: number
): number {
  return normalize(completedJobs, 0, MAX_COMPLETED_JOBS);
}

export function calculateWorkloadScore(
  activeJobs: number
): number {
  return 1 - normalize(activeJobs, 0, MAX_ACTIVE_JOBS);
}

export interface WorkerRankingInput {
  distanceKm: number;
  rating: number;
  completedJobs: number;
  activeJobs: number;
}

export interface WorkerRankingResult {
  distanceScore: number;
  ratingScore: number;
  experienceScore: number;
  workloadScore: number;
  totalScore: number;
}

export function calculateWorkerScore(
  worker: WorkerRankingInput
): WorkerRankingResult {
  const distanceScore = calculateDistanceScore(worker.distanceKm);

  const ratingScore = calculateRatingScore(worker.rating);

  const experienceScore =
    calculateExperienceScore(worker.completedJobs);

  const workloadScore =
    calculateWorkloadScore(worker.activeJobs);

  const totalScore =
    distanceScore * DISTANCE_WEIGHT +
    ratingScore * RATING_WEIGHT +
    experienceScore * EXPERIENCE_WEIGHT +
    workloadScore * WORKLOAD_WEIGHT;

  return {
    distanceScore,
    ratingScore,
    experienceScore,
    workloadScore,
    totalScore,
  };
}

export interface RankedWorker extends WorkerRankingInput {
  workerId: number;
}

export function rankWorkers(
  workers: RankedWorker[]
) {
  return workers
    .map((worker) => ({
      ...worker,
      ranking: calculateWorkerScore(worker),
    }))
    .sort(
      (a, b) =>
        b.ranking.totalScore -
        a.ranking.totalScore
    );
}