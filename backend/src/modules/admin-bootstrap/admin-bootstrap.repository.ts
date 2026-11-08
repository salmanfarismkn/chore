import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { adminBootstrapState, authIdentities, users } from "../../db/schema";

export type AdminBootstrapResult =
  | { status: "created"; userId: number }
  | { status: "already_completed" }
  | { status: "administrator_exists" }
  | { status: "user_not_eligible" };

export class AdminBootstrapRepository {
  async provision(userId: number): Promise<AdminBootstrapResult> {
    return db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(adminBootstrapState)
        .where(eq(adminBootstrapState.id, 1))
        .for("update");

      if (!state) {
        throw new Error("Admin bootstrap state is missing");
      }

      if (state.completedAt !== null) {
        return { status: "already_completed" };
      }

      const [administrator] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "admin"))
        .limit(1);

      if (administrator) {
        await tx
          .update(adminBootstrapState)
          .set({
            completedAt: new Date(),
            completedBy: administrator.id,
          })
          .where(eq(adminBootstrapState.id, 1));
        return { status: "administrator_exists" };
      }

      const [candidate] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(authIdentities, eq(authIdentities.userId, users.id))
        .where(and(eq(users.id, userId), eq(users.isActive, true)))
        .for("update", { of: users });

      if (!candidate) {
        return { status: "user_not_eligible" };
      }

      const [promoted] = await tx
        .update(users)
        .set({ role: "admin", updatedAt: new Date() })
        .where(
          and(
            eq(users.id, userId),
            eq(users.isActive, true),
            eq(users.role, "customer"),
          ),
        )
        .returning({ id: users.id });

      if (!promoted) {
        return { status: "user_not_eligible" };
      }

      await tx
        .update(adminBootstrapState)
        .set({ completedAt: new Date(), completedBy: promoted.id })
        .where(eq(adminBootstrapState.id, 1));

      return { status: "created", userId: promoted.id };
    });
  }
}
