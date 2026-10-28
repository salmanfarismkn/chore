export interface CreateWorkerInput {
  userId: number;
  bio: string;
}

export interface UpdateWorkerInput {
  bio?: string;
  status?: "offline" | "available" | "busy" | "suspended";
}

export interface WorkerResponse {
  id: number;
  userId: number;
  bio: string | null;
  averageRating: number;
  completedJobs: number;
  status: "offline" | "available" | "busy" | "suspended";
}