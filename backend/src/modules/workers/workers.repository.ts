import { and, eq, isNull, ne } from "drizzle-orm";

import { db } from "../../db";
import {
  users,
  workerApprovalAuditEvents,
  workerProfiles,
} from "../../db/schema";

import type {
  CreateWorkerInput,
  UpdateWorkerInput,
  WorkerResponse,
} from "./workers.types";

export type WorkerApprovalStatus = "pending" | "approved" | "rejected";

export class InvalidWorkerApprovalTransitionError extends Error {
  constructor(
    public readonly currentStatus: WorkerApprovalStatus,
    public readonly requestedStatus: WorkerApprovalStatus,
  ) {
    super(
      `Invalid worker approval transition: ${currentStatus} -> ${requestedStatus}`,
    );
    this.name = "InvalidWorkerApprovalTransitionError";
  }
}

export class WorkerCannotDecideOwnApprovalError extends Error {
  constructor() {
    super("A worker cannot decide their own approval");
    this.name = "WorkerCannotDecideOwnApprovalError";
  }
}

export class WorkerApprovalActorUnauthorizedError extends Error {
  constructor() {
    super("Worker approval requires an active local administrator");
    this.name = "WorkerApprovalActorUnauthorizedError";
  }
}

export class WorkersRepository {
  async createWorker(data: CreateWorkerInput): Promise<WorkerResponse> {
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
        approvalStatus: workerProfiles.approvalStatus,
        approvalDecidedBy: workerProfiles.approvalDecidedBy,
        approvalDecidedAt: workerProfiles.approvalDecidedAt,
      });

    return {
      id: worker.id,
      userId: worker.userId,
      bio: worker.bio,
      averageRating: worker.averageRating ?? 0,
      completedJobs: worker.completedJobs ?? 0,
      status: worker.status ?? "offline",
      approvalStatus: worker.approvalStatus,
      approvalDecidedBy: worker.approvalDecidedBy,
      approvalDecidedAt: worker.approvalDecidedAt,
    };
  }

  async decideApproval(
    id: number,
    approvalStatus: Exclude<WorkerApprovalStatus, "pending">,
    decidedBy: number,
    reason?: string,
  ) {
    return db.transaction(async (tx) => {
      const [actor] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, decidedBy),
            eq(users.role, "admin"),
            eq(users.isActive, true),
          ),
        )
        .for("share");

      if (!actor) {
        throw new WorkerApprovalActorUnauthorizedError();
      }

      const [current] = await tx
        .select()
        .from(workerProfiles)
        .where(eq(workerProfiles.id, id))
        .for("update");

      if (!current) {
        return null;
      }

      if (current.userId === decidedBy) {
        throw new WorkerCannotDecideOwnApprovalError();
      }

      if (current.approvalStatus === approvalStatus) {
        return {
          worker: current,
          changed: false,
          previousStatus: current.approvalStatus,
        };
      }

      if (
        current.approvalStatus === "rejected" &&
        approvalStatus === "approved"
      ) {
        throw new InvalidWorkerApprovalTransitionError(
          current.approvalStatus,
          approvalStatus,
        );
      }

      const now = new Date();
      const [worker] = await tx
        .update(workerProfiles)
        .set({
          approvalStatus,
          approvalDecidedBy: decidedBy,
          approvalDecidedAt: now,
          updatedAt: now,
        })
        .where(eq(workerProfiles.id, id))
        .returning();

      await tx.insert(workerApprovalAuditEvents).values({
        workerProfileId: worker.id,
        previousStatus: current.approvalStatus,
        newStatus: approvalStatus,
        actorUserId: actor.id,
        decidedAt: now,
        reason: reason ?? null,
      });

      return {
        worker,
        changed: true,
        previousStatus: current.approvalStatus,
      };
    });
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

  async updateWorker(id: number, data: UpdateWorkerInput) {
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

  async updateStatus(
    userId: number,
    status: "offline" | "available" | "busy" | "suspended",
  ) {
    const [worker] = await db
      .update(workerProfiles)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(workerProfiles.userId, userId))
      .returning();

    return worker ?? null;
  }

  async updateOperationalStatus(
    userId: number,
    status: Exclude<
      "offline" | "available" | "busy" | "suspended",
      "suspended"
    >,
  ) {
    const [worker] = await db
      .update(workerProfiles)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(workerProfiles.userId, userId),
          isNull(workerProfiles.deletedAt),
          ne(workerProfiles.status, "suspended"),
          ...(status === "available"
            ? [eq(workerProfiles.approvalStatus, "approved")]
            : []),
        ),
      )
      .returning();

    return worker ?? null;
  }
}
