import { eq } from "drizzle-orm";

import { db } from "../../db";
import { workerProfiles } from "../../db/schema";

import type {
  CreateWorkerInput,
  WorkerResponse,
} from "./workers.types";

export class WorkersRepository {
  async createWorker(
    data: CreateWorkerInput
  ): Promise<WorkerResponse> {
    const [worker] = await db
      .insert(workerProfiles)
      .values({
        userId: data.userId,
        bio: data.bio,
      })
      .returning({
        id: workerProfiles.id,
        userId: workerProfiles.userId,
        bio: workerProfiles.bio,
        averageRating: workerProfiles.averageRating,
        completedJobs: workerProfiles.completedJobs,
        status: workerProfiles.status,
      });

    return {
      id: worker.id,
      userId: worker.userId,
      bio: worker.bio,
      averageRating: worker.averageRating ?? 0,
      completedJobs: worker.completedJobs ?? 0,
      status: worker.status ?? "offline",
    };
  }

  async findWorkerById(id: number) {
    const [worker] = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, id));

    return worker ?? null;
  }

  async findWorkerByUserId(userId: number) {
    const [worker] = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.userId, userId));

    return worker ?? null;
  }

  async findAllWorkers() {
    return db.select().from(workerProfiles);
  }
  
  async updateWorker(
    id: number,
    data: Partial<CreateWorkerInput>
  ) {
    const [worker] = await db
      .update(workerProfiles)
      .set(data)
      .where(eq(workerProfiles.id, id))
      .returning();

    return worker ?? null;
  }

  async deleteWorker(id: number) {
    const [worker] = await db
      .update(workerProfiles)
      .set({
      deletedAt: new Date(),
      })
      .where(eq(workerProfiles.id, id));

    return worker ?? null;
  }
}