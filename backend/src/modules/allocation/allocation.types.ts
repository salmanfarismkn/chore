export interface AllocationCandidate {
  workerId: number;
  workerServiceId: number;

  workerName: string;

  averageRating: number;
  completedJobs: number;

  price: string;

  score: number;
}