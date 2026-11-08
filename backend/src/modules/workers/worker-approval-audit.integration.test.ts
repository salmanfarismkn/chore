import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import Fastify from "fastify";

import { db } from "../../db";
import {
  users,
  workerApprovalAuditEvents,
  workerProfiles,
} from "../../db/schema";
import {
  InvalidWorkerApprovalTransitionError,
  WorkerApprovalActorUnauthorizedError,
  WorkersRepository,
} from "./workers.repository";
import type { AuthUser } from "../auth/auth.types";
import { registerWorkerRoutes } from "./workers.routes";
import type { RateLimitCounter } from "../../config/rate-limit";

describe("worker approval audit PostgreSQL integration", () => {
  let adminId: number;
  let customerId: number;
  let workerId: number;
  let workerProfileId: number;

  beforeAll(async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const [admin] = await db
      .insert(users)
      .values({
        phoneNumber: `+1553${suffix.slice(0, 15)}`,
        fullName: "Approval audit administrator",
        role: "admin",
      })
      .returning({ id: users.id });
    const [customer] = await db
      .insert(users)
      .values({
        phoneNumber: `+1554${suffix.slice(0, 15)}`,
        fullName: "Approval audit customer",
        role: "customer",
      })
      .returning({ id: users.id });
    adminId = admin.id;
    customerId = customer.id;
  });

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const [worker] = await db
      .insert(users)
      .values({
        phoneNumber: `+1555${suffix.slice(0, 15)}`,
        fullName: "Approval audit worker",
        role: "worker",
      })
      .returning({ id: users.id });
    workerId = worker.id;
    const [profile] = await db
      .insert(workerProfiles)
      .values({ userId: worker.id })
      .returning({ id: workerProfiles.id });
    workerProfileId = profile.id;
  });

  afterEach(async () => {
    await db
      .delete(workerProfiles)
      .where(eq(workerProfiles.id, workerProfileId));
    await db.delete(users).where(eq(users.id, workerId));
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, customerId));
  });

  it("writes exactly one event per real transition and serializes concurrent duplicate decisions", async () => {
    const repository = new WorkersRepository();
    const approval = await repository.decideApproval(
      workerProfileId,
      "approved",
      adminId,
      "Documents reviewed",
    );
    expect(approval?.worker.approvalStatus).toBe("approved");

    await repository.decideApproval(
      workerProfileId,
      "approved",
      adminId,
      "Repeated request",
    );
    const repeatedEvents = await db
      .select()
      .from(workerApprovalAuditEvents)
      .where(eq(workerApprovalAuditEvents.workerProfileId, workerProfileId));
    expect(repeatedEvents).toHaveLength(1);
    expect(repeatedEvents[0]).toMatchObject({
      previousStatus: "pending",
      newStatus: "approved",
      actorUserId: adminId,
      reason: "Documents reviewed",
    });

    await Promise.all([
      repository.decideApproval(workerProfileId, "rejected", adminId),
      repository.decideApproval(workerProfileId, "rejected", adminId),
    ]);
    const events = await db
      .select()
      .from(workerApprovalAuditEvents)
      .where(eq(workerApprovalAuditEvents.workerProfileId, workerProfileId));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      previousStatus: "approved",
      newStatus: "rejected",
      actorUserId: adminId,
    });

    const app = Fastify({ logger: false });
    app.decorate("authenticate", async (request) => {
      request.user = { userId: adminId, role: "admin" } as AuthUser;
    });
    app.decorate("requireWorker", async () => undefined);
    const testRateLimitCounter: RateLimitCounter = async () => ({
      count: 1,
      ttlMs: 60_000,
    });
    await app.register(registerWorkerRoutes, {
      prefix: "/v1/workers",
      rateLimitCounter: testRateLimitCounter,
    });
    await app.ready();
    try {
      const patchAttempt = await app.inject({
        method: "PATCH",
        url: `/v1/workers/approval-audit/${events[0].id}`,
        payload: { reason: "Changed history" },
      });
      const deleteAttempt = await app.inject({
        method: "DELETE",
        url: `/v1/workers/approval-audit/${events[0].id}`,
      });
      expect(patchAttempt.statusCode).toBe(404);
      expect(deleteAttempt.statusCode).toBe(404);
    } finally {
      await app.close();
    }

    await expect(
      repository.decideApproval(workerProfileId, "approved", adminId),
    ).rejects.toBeInstanceOf(InvalidWorkerApprovalTransitionError);
    const afterInvalidTransition = await db
      .select()
      .from(workerApprovalAuditEvents)
      .where(eq(workerApprovalAuditEvents.workerProfileId, workerProfileId));
    expect(afterInvalidTransition).toHaveLength(2);
  });

  it("rejects a caller who is no longer an active local administrator", async () => {
    const repository = new WorkersRepository();
    await expect(
      repository.decideApproval(workerProfileId, "approved", customerId),
    ).rejects.toBeInstanceOf(WorkerApprovalActorUnauthorizedError);
    const [profile] = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, workerProfileId));
    const events = await db
      .select()
      .from(workerApprovalAuditEvents)
      .where(eq(workerApprovalAuditEvents.workerProfileId, workerProfileId));
    expect(profile.approvalStatus).toBe("pending");
    expect(events).toHaveLength(0);
  });

  it("rolls back approval state when the audit insert fails", async () => {
    const repository = new WorkersRepository();
    await expect(
      repository.decideApproval(
        workerProfileId,
        "approved",
        adminId,
        "r".repeat(501),
      ),
    ).rejects.toBeDefined();
    const [profile] = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, workerProfileId));
    const events = await db
      .select()
      .from(workerApprovalAuditEvents)
      .where(eq(workerApprovalAuditEvents.workerProfileId, workerProfileId));
    expect(profile.approvalStatus).toBe("pending");
    expect(events).toHaveLength(0);
  });
});
