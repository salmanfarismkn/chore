import { ConflictError } from "../../shared/core/errors/conflict-error";
import { NotFoundError } from "../../shared/core/errors/not-found-error";

import { UsersRepository } from "../users/users.repository";
import { WorkersRepository } from "./workers.repository";

import type {
  CreateWorkerInput,
  WorkerResponse,
} from "./workers.types";

export class WorkersService {
  constructor(
    private readonly workersRepository: WorkersRepository,
    private readonly usersRepository: UsersRepository
  ) {}

  async createWorker(
    data: CreateWorkerInput
  ): Promise<WorkerResponse> {
    const user = await this.usersRepository.findUserById(data.userId);

    if (!user) {
      throw new NotFoundError("User not found");
    }

    const existing =
      await this.workersRepository.findWorkerByUserId(
        data.userId
      );

    if (existing) {
      throw new ConflictError(
        "Worker profile already exists"
      );
    }

    return this.workersRepository.createWorker(data);
  }

  async getWorkerById(id: number) {
    return this.workersRepository.findWorkerById(id);
  }

  async getAllWorkers() {
    return this.workersRepository.findAllWorkers();
  }
  
  async updateWorker(
    id: number,
    data: Partial<CreateWorkerInput>
  ) {
    const worker =
      await this.workersRepository.findWorkerById(id);

    if (!worker) {
      throw new NotFoundError("Worker not found");
    }

    return this.workersRepository.updateWorker(id, data);
  }

  async deleteWorker(id: number) {
    const worker =
      await this.workersRepository.findWorkerById(id);

    if (!worker) {
      throw new NotFoundError("Worker not found");
    }

    return this.workersRepository.deleteWorker(id);
  }
}