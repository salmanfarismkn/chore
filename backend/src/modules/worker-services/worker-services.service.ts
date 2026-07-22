import { ConflictError } from "../../shared/core/errors/conflict-error";
import { NotFoundError } from "../../shared/core/errors/not-found-error";

import { WorkerServicesRepository } from "./worker-services.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { ServicesRepository } from "../service-categories/services.repository";

import type {
  CreateWorkerServiceInput,
  WorkerServiceResponse,
} from "./worker-services.types";

export class WorkerServicesService {
  constructor(
    private readonly workerServicesRepository: WorkerServicesRepository,
    private readonly workersRepository: WorkersRepository,
    private readonly servicesRepository: ServicesRepository
  ) {}

  async createWorkerService(
    data: CreateWorkerServiceInput
  ): Promise<WorkerServiceResponse> {
    const worker = await this.workersRepository.findWorkerById(
      data.workerId
    );

    if (!worker) {
      throw new NotFoundError("Worker not found");
    }

    const service =
      await this.servicesRepository.findServiceById(
        data.serviceCategoryId
      );

    if (!service) {
      throw new NotFoundError("Service category not found");
    }

    const existing =
      await this.workerServicesRepository.findWorkerService(
        data.workerId,
        data.serviceCategoryId
      );

    if (existing) {
      throw new ConflictError(
        "Worker already provides this service"
      );
    }

    return this.workerServicesRepository.createWorkerService(
      data
    );
  }

  async getAllWorkerServices() {
    return this.workerServicesRepository.findAllWorkerServices();
  }

  async getServicesForWorker(workerId: number) {
    return this.workerServicesRepository.findServicesForWorker(
      workerId
    );
  }

  async getWorkersForService(serviceCategoryId: number) {
    return this.workerServicesRepository.findWorkersForService(
      serviceCategoryId
    );
  }
}