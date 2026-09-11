import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { workerServices, serviceCategories } from "../../db/schema";

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
      })
      .returning({
        workerId: workerServices.workerId,
        serviceCategoryId: workerServices.serviceCategoryId,
        isActive: workerServices.isActive,
        createdAt: workerServices.createdAt,
        updatedAt: workerServices.updatedAt,
      });

    if (!workerService) {
      throw new Error("Failed to create worker service");
    }

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
        workerId: workerServices.workerId,
        serviceCategoryId: workerServices.serviceCategoryId,
        serviceName: serviceCategories.name,
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
}