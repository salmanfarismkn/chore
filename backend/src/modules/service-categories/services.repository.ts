import { eq } from "drizzle-orm";

import { db } from "../../db";
import { serviceCategories } from "../../db/schema";

import type {
  CreateServiceInput,
  ServiceResponse,
} from "./services.types";

export class ServicesRepository {
  async createService(
    data: CreateServiceInput
  ): Promise<ServiceResponse> {
    const [service] = await db
      .insert(serviceCategories)
      .values({
        name: data.name,
        description: data.description ?? null,
        basePrice: data.basePrice.toString(),
        estimatedDurationMinutes: data.estimatedDurationMinutes,
      })
      .returning();

    if (!service) return null as any;

    return {
      id: service.id,
      name: service.name,
      description: service.description ?? null,
      basePrice: service.basePrice,
      estimatedDurationMinutes: service.estimatedDurationMinutes,
      isActive: service.isActive,
      createdAt: service.createdAt,
    };
  }

  async findServiceById(id: number) {
    const [service] = await db
      .select()
      .from(serviceCategories)
      .where(eq(serviceCategories.id, id));

    if (!service) return null;

    return {
      id: service.id,
      name: service.name,
      description: service.description ?? null,
      basePrice: service.basePrice,
      estimatedDurationMinutes: service.estimatedDurationMinutes,
      isActive: service.isActive,
      createdAt: service.createdAt,
    };
  }

  async findServiceByName(name: string) {
    const [service] = await db
      .select()
      .from(serviceCategories)
      .where(eq(serviceCategories.name, name));

    if (!service) return null;

    return {
      id: service.id,
      name: service.name,
      description: service.description ?? null,
      basePrice: service.basePrice,
      estimatedDurationMinutes: service.estimatedDurationMinutes,
      isActive: service.isActive,
      createdAt: service.createdAt,
    };
  }

  async findAllServices() {
    const services = await db.select().from(serviceCategories);

    return services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? null,
      basePrice: s.basePrice,
      estimatedDurationMinutes: s.estimatedDurationMinutes,
      isActive: s.isActive,
      createdAt: s.createdAt,
    }));
  }
}