import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../../db";
import { adminBootstrapState, authIdentities, users } from "../../db/schema";
import { AdminBootstrapService } from "./admin-bootstrap.service";

const integrationEnabled = process.env.RUN_ADMIN_BOOTSTRAP_INTEGRATION === "1";
const bootstrapSecret = randomBytes(32).toString("base64url");

describe.skipIf(!integrationEnabled)(
  "initial administrator bootstrap PostgreSQL integration",
  () => {
    const fixtureIds: number[] = [];
    let firstUserId: number;
    let secondUserId: number;

    const createMappedCustomer = async (label: string) => {
      const suffix = randomUUID().replaceAll("-", "");
      const [user] = await db
        .insert(users)
        .values({
          phoneNumber: `+1551${suffix.slice(0, 15)}`,
          fullName: label,
          role: "customer",
        })
        .returning({ id: users.id });
      fixtureIds.push(user.id);
      await db.insert(authIdentities).values({
        userId: user.id,
        issuer: "https://pronto-bootstrap-test.auth0.com/",
        subject: `auth0|${suffix}`,
      });
      return user.id;
    };

    beforeAll(async () => {
      firstUserId = await createMappedCustomer("Bootstrap candidate one");
      secondUserId = await createMappedCustomer("Bootstrap candidate two");
    });

    beforeEach(async () => {
      await db
        .update(users)
        .set({ role: "customer" })
        .where(and(eq(users.id, firstUserId), eq(users.role, "admin")));
      await db
        .update(users)
        .set({ role: "customer" })
        .where(and(eq(users.id, secondUserId), eq(users.role, "admin")));
      await db
        .update(adminBootstrapState)
        .set({ completedAt: null, completedBy: null })
        .where(eq(adminBootstrapState.id, 1));
    });

    afterAll(async () => {
      if (fixtureIds.length > 0) {
        await db.delete(users).where(eq(users.id, firstUserId));
        await db
          .delete(authIdentities)
          .where(eq(authIdentities.userId, secondUserId));
        await db.delete(users).where(eq(users.id, secondUserId));
        await db
          .update(adminBootstrapState)
          .set({ completedAt: null, completedBy: null })
          .where(eq(adminBootstrapState.id, 1));
      }
    });

    it("closes bootstrap when an administrator already exists and does not reopen after removal", async () => {
      await db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.id, firstUserId));

      const service = new AdminBootstrapService(undefined, bootstrapSecret);
      await expect(
        service.provision(secondUserId, bootstrapSecret),
      ).rejects.toMatchObject({ reason: "administrator_exists" });

      await db
        .update(users)
        .set({ role: "customer" })
        .where(eq(users.id, firstUserId));
      await expect(
        service.provision(secondUserId, bootstrapSecret),
      ).rejects.toMatchObject({ reason: "already_completed" });
      const [candidate] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, secondUserId));
      expect(candidate.role).toBe("customer");
    });

    it("serializes concurrent bootstrap attempts and provisions only one administrator", async () => {
      const serviceOne = new AdminBootstrapService(undefined, bootstrapSecret);
      const serviceTwo = new AdminBootstrapService(undefined, bootstrapSecret);
      const results = await Promise.allSettled([
        serviceOne.provision(firstUserId, bootstrapSecret),
        serviceTwo.provision(secondUserId, bootstrapSecret),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const administrators = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "admin"));
      expect(administrators).toHaveLength(1);

      const promoted = administrators[0].id;
      await expect(
        new AdminBootstrapService(undefined, bootstrapSecret).provision(
          promoted,
          bootstrapSecret,
        ),
      ).rejects.toMatchObject({ reason: "already_completed" });
    });

    it("does not promote a user without a linked external identity", async () => {
      const [unmapped] = await db
        .insert(users)
        .values({
          phoneNumber: `+1552${randomUUID().replaceAll("-", "").slice(0, 15)}`,
          fullName: "Unmapped candidate",
          role: "customer",
        })
        .returning({ id: users.id });
      try {
        await expect(
          new AdminBootstrapService(undefined, bootstrapSecret).provision(
            unmapped.id,
            bootstrapSecret,
          ),
        ).rejects.toMatchObject({ reason: "user_not_eligible" });
        const [unchanged] = await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, unmapped.id));
        expect(unchanged.role).toBe("customer");
      } finally {
        await db.delete(users).where(eq(users.id, unmapped.id));
      }
    });

    it("does not promote a linked user when the operator secret is incorrect", async () => {
      await expect(
        new AdminBootstrapService(undefined, bootstrapSecret).provision(
          firstUserId,
          randomBytes(32).toString("base64url"),
        ),
      ).rejects.toMatchObject({ reason: "invalid_secret" });
      const [unchanged] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, firstUserId));
      expect(unchanged.role).toBe("customer");
    });
  },
);
