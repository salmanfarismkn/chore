export interface CreateWorkerServiceInput {
  workerId: number;
  serviceCategoryId: number;
}

export interface WorkerServiceResponse {
  workerId: number;
  serviceCategoryId: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}