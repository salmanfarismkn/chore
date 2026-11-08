import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../../db";
import { appSessions, users, workerProfiles } from "../../db/schema";
import sessionAuthPlugin from "../../plugins/session-auth";
import { SessionService } from "./session.service";

let fixtureCounter = 0;
const fixtureUserIds: number[] = [];

const createUser = async (role: "customer" | "worker" = "customer") => {
  fixtureCounter += 1;
  const [user] = await db
    .insert(users)
    .values({
      phoneNumber: `+1${Date.now()}${fixtureCounter}`,
      fullName: "Application session integration user",
      role,
    })
    .returning();
  fixtureUserIds.push(user.id);
  return user;
};

const createProtectedApp = async () => {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  app.get(
    "/protected",
    { preHandler: [app.authenticate] },
    async (request) => request.user,
  );
  await app.ready();
  return app;
};

afterEach(async () => {
  if (fixtureUserIds.length === 0) {
    return;
  }
  await db
    .delete(workerProfiles)
    .where(inArray(workerProfiles.userId, fixtureUserIds));
  await db.delete(users).where(inArray(users.id, fixtureUserIds));
  fixtureUserIds.length = 0;
});

describe("application session PostgreSQL integration", () => {
  it("persists only the verifier and shares revocation across service instances", async () => {
    const user = await createUser();
    const firstInstance = new SessionService();
    const secondInstance = new SessionService();
    const created = await firstInstance.create(user.id, "native");
    const [persisted] = await db
      .select()
      .from(appSessions)
      .where(eq(appSessions.id, created.id));

    expect(persisted.tokenHash).not.toContain(created.credential);
    expect(persisted.tokenHash).toHaveLength(64);
    expect(persisted).not.toHaveProperty("role");
    await expect(
      secondInstance.authenticate(created.credential, "native"),
    ).resolves.toMatchObject({ userId: user.id, role: "customer" });

    await firstInstance.revokeAllForUser(user.id);
    await expect(
      secondInstance.authenticate(created.credential, "native"),
    ).rejects.toMatchObject({ reason: "invalid_credential" });
  });

  it("makes PostgreSQL revocation visible to independently constructed Fastify instances", async () => {
    const user = await createUser();
    const sessionService = new SessionService();
    const created = await sessionService.create(user.id, "native");
    const firstApp = await createProtectedApp();
    const secondApp = await createProtectedApp();

    try {
      for (const app of [firstApp, secondApp]) {
        const response = await app.inject({
          method: "GET",
          url: "/protected",
          headers: { authorization: `Bearer ${created.credential}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ userId: user.id, role: "customer" });
      }

      await new SessionService().revoke(created.id);
      const response = await secondApp.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${created.credential}` },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await Promise.all([firstApp.close(), secondApp.close()]);
    }
  });

  it("reflects local account, role, profile, and suspension changes for existing sessions", async () => {
    const user = await createUser("worker");
    await db
      .insert(workerProfiles)
      .values({
        userId: user.id,
      });
    const service = new SessionService();
    const created = await service.create(user.id, "native");

    await expect(
      service.authenticate(created.credential, "native"),
    ).resolves.toMatchObject({ role: "worker" });
    await expect(service.authorizeWorker(user.id)).rejects.toMatchObject({
      reason: "worker_unavailable",
    });

    await db
      .update(workerProfiles)
      .set({
        status: "available",
        approvalStatus: "approved",
        approvalDecidedAt: new Date(),
      })
      .where(eq(workerProfiles.userId, user.id));
    await expect(
      service.authorizeWorker(user.id, true),
    ).resolves.toBeUndefined();

    await db
      .update(workerProfiles)
      .set({ status: "suspended" })
      .where(eq(workerProfiles.userId, user.id));
    await expect(service.authorizeWorker(user.id)).rejects.toMatchObject({
      reason: "worker_unavailable",
    });

    await db
      .update(workerProfiles)
      .set({ status: "available", approvalStatus: "rejected" })
      .where(eq(workerProfiles.userId, user.id));
    await expect(service.authorizeWorker(user.id)).rejects.toMatchObject({
      reason: "worker_unavailable",
    });

    await db
      .update(users)
      .set({ role: "customer" })
      .where(eq(users.id, user.id));
    await expect(
      service.authenticate(created.credential, "native"),
    ).resolves.toMatchObject({ role: "customer" });

    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, user.id));
    await expect(
      service.authenticate(created.credential, "native"),
    ).rejects.toMatchObject({ reason: "invalid_credential" });
  });
});
