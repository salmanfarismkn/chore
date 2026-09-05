export interface AllocationCandidate {
  workerId: number;
  workerServiceId?: number;

  workerName: string;

  latitude: number;
  longitude: number;

  averageRating: number;
  completedJobs: number;
  distanceKm: number;
  price?: string;

  score: number;
}

export interface AllocationTier {
  name: string; 
  candidates: AllocationCandidate[]; 
  timeoutSeconds: number; 
}