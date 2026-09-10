import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../db";

import {
  workerProfiles,
  workerServices,
  serviceCategories,
  users,
  bookings,
} from "../../db/schema";

export class AllocationRepository {
  async findCandidates(serviceCategoryId: number) {
    return db
      .select({
        workerId: workerProfiles.id,

        workerName: users.fullName,

        averageRating: workerProfiles.averageRating,

        completedJobs: workerProfiles.completedJobs,

        latitude: workerProfiles.latitude,

        longitude: workerProfiles.longitude,

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
          eq(workerServices.serviceCategoryId, serviceCategoryId),
          eq(workerServices.isActive, true),
          eq(workerProfiles.status, "available")
        )
      );
  }
  
  async getWorkerActiveJobCounts(
    workerIds: number[]
  ): Promise<Map<number, number>> {
    if (workerIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        workerId: bookings.workerId,
      })
      .from(bookings)
      .where(
        and(
          inArray(bookings.workerId, workerIds),
          inArray(bookings.status, [
            "ASSIGNED",
            "EN_ROUTE",
            "WORKING",
          ])
        )
      );

    const counts = new Map<number, number>();

    for (const row of rows) {
      if (row.workerId === null) {
        continue;
      }

      counts.set(
        row.workerId,
        (counts.get(row.workerId) ?? 0) + 1
      );
    }

    return counts;
  }
}
