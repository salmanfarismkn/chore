import { ConflictError } from "../../shared/core/errors/conflict-error";
import { ServicesRepository } from "./services.repository";

import type { CreateServiceInput } from "./services.types";

export class ServicesService {
  constructor(private readonly repository: ServicesRepository) {}

  async createService(data: CreateServiceInput) {
    const existing =
      await this.repository.findServiceByName(
        data.name
      );

    if (existing) {
      throw new ConflictError(
        "Service already exists"
      );
    }

    return this.repository.createService(data);
  }

  async getAllServices() {
    return this.repository.findAllServices();
  }

  async getServiceById(id: number) {
    return this.repository.findServiceById(id);
  }
}