import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { authIdentities, users } from "../../db/schema";
import { NotFoundError } from "../../shared/core/errors/not-found-error";
import { IdentityMappingConflictError } from "./identity.errors";

export interface ExternalIdentity {
  issuer: string;
  subject: string;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505";

export class IdentityRepository {
  async findByIssuerAndSubject(issuer: string, subject: string) {
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.issuer, issuer),
          eq(authIdentities.subject, subject),
        ),
      );

    return identity ?? null;
  }

  async findByUserId(userId: number) {
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));

    return identity ?? null;
  }

  async createIdentityMapping(identity: ExternalIdentity, userId: number) {
    return this.insertMapping(identity, userId);
  }

  async linkIdentityToUser(identity: ExternalIdentity, userId: number) {
    return this.insertMapping(identity, userId);
  }

  private async insertMapping(identity: ExternalIdentity, userId: number) {
    try {
      return await db.transaction(async (tx) => {
        await this.lockExistingUser(tx, userId);

        const [existingIdentity] = await tx
          .select({ id: authIdentities.id })
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.issuer, identity.issuer),
              eq(authIdentities.subject, identity.subject),
            ),
          );

        if (existingIdentity) {
          throw new IdentityMappingConflictError(
            "identity_already_linked",
            "External identity is already linked",
          );
        }

        const [existingUserIdentity] = await tx
          .select({ id: authIdentities.id })
          .from(authIdentities)
          .where(eq(authIdentities.userId, userId));

        if (existingUserIdentity) {
          throw new IdentityMappingConflictError(
            "user_already_has_identity",
            "Local user already has a primary external identity",
          );
        }

        const [createdIdentity] = await tx
          .insert(authIdentities)
          .values({
            userId,
            issuer: identity.issuer,
            subject: identity.subject,
          })
          .returning();

        return createdIdentity;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const existingIdentity = await this.findByIssuerAndSubject(
        identity.issuer,
        identity.subject,
      );

      if (existingIdentity) {
        throw new IdentityMappingConflictError(
          "identity_already_linked",
          "External identity is already linked",
        );
      }

      const existingUserIdentity = await this.findByUserId(userId);

      if (existingUserIdentity) {
        throw new IdentityMappingConflictError(
          "user_already_has_identity",
          "Local user already has a primary external identity",
        );
      }

      throw error;
    }
  }

  private async lockExistingUser(tx: Transaction, userId: number) {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    if (!user) {
      throw new NotFoundError("Local user not found");
    }

    return user;
  }
}
