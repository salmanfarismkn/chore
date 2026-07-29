export interface CreateWorkerServiceInput {
  workerId: number;
  serviceCategoryId: number;
  price: number;
}

export interface WorkerServiceResponse {
  workerId: number;
  serviceCategoryId: number;
  price: string;
  isActive: boolean;
}