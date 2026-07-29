import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import {
  workerServices,
  workerProfiles,
  serviceCategories,
} from "../../db/schema";

import type {
  CreateWorkerServiceInput,
  WorkerServiceResponse,
} from "./worker-services.types";

export class WorkerServicesRepository {
  async createWorkerService(
    data: CreateWorkerServiceInput
  ): Promise<WorkerServiceResponse> {
    const [workerService] = await db
      .insert(workerServices)
      .values({
        workerId: data.workerId,
        serviceCategoryId: data.serviceCategoryId,
        price: data.price.toString(),
      })
      .returning({
        id: workerServices.id,
        workerId: workerServices.workerId,
        serviceCategoryId: workerServices.serviceCategoryId,
        price: workerServices.price,
        isActive: workerServices.isActive,
      });

    return workerService;
  }

  async findWorkerService(
    workerId: number,
    serviceCategoryId: number
  ) {
    const [workerService] = await db
      .select()
      .from(workerServices)
      .where(
        and(
          eq(workerServices.workerId, workerId),
          eq(
            workerServices.serviceCategoryId,
            serviceCategoryId
          )
        )
      );

    return workerService ?? null;
  }

  async findAllWorkerServices() {
    return db.select().from(workerServices);
  }

  async findServicesForWorker(workerId: number) {
    return db
      .select({
        id: workerServices.id,

        serviceId: serviceCategories.id,

        serviceName: serviceCategories.name,

        price: workerServices.price,

        isActive: workerServices.isActive,
      })
      .from(workerServices)
      .innerJoin(
        serviceCategories,
        eq(
          workerServices.serviceCategoryId,
          serviceCategories.id
        )
      )
      .where(eq(workerServices.workerId, workerId));
  }

  async findWorkersForService(serviceCategoryId: number) {
    return db
      .select({
        workerId: workerProfiles.id,

        price: workerServices.price,

        averageRating:
          workerProfiles.averageRating,

        completedJobs:
          workerProfiles.completedJobs,

        status: workerProfiles.status,
      })
      .from(workerServices)
      .innerJoin(
        workerProfiles,
        eq(
          workerServices.workerId,
          workerProfiles.id
        )
      )
      .where(
        eq(
          workerServices.serviceCategoryId,
          serviceCategoryId
        )
      );
  }

  async updatePrice(
    id: number,
    price: number
  ) {
    const [workerService] = await db
      .update(workerServices)
      .set({
        price: price.toString(),
      })
      .where(eq(workerServices.id, id))
      .returning();

    return workerService ?? null;
  }

  async deactivateWorkerService(id: number) {
    const [workerService] = await db
      .update(workerServices)
      .set({
        isActive: false,
      })
      .where(eq(workerServices.id, id))
      .returning();

    return workerService ?? null;
  }
}