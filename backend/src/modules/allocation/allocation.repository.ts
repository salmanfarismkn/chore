import { and, eq } from "drizzle-orm";

import { db } from "../../db";

import {
  workerProfiles,
  workerServices,
  serviceCategories,
  users,
} from "../../db/schema";

export class AllocationRepository {
  async findCandidates(serviceCategoryId: number) {
    return db
      .select({
        workerId: workerProfiles.id,

        workerServiceId: workerServices.id,

        workerName: users.fullName,

        averageRating: workerProfiles.averageRating,

        completedJobs: workerProfiles.completedJobs,

        price: workerServices.price,
      })
      .from(workerServices)

      .innerJoin(
        workerProfiles,
        eq(workerServices.workerId, workerProfiles.id)
      )

      .innerJoin(
        users,
        eq(workerProfiles.userId, users.id)
      )

      .innerJoin(
        serviceCategories,
        eq(
          workerServices.serviceCategoryId,
          serviceCategories.id
        )
      )

      .where(
        and(
          eq(
            workerServices.serviceCategoryId,
            serviceCategoryId
          ),
          eq(workerServices.isActive, true)
        )
      );
  }
}
