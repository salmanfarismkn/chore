import { and, eq, gt, isNull } from "drizzle-orm";

import { db } from "../../db";
import { appSessions, users, workerProfiles } from "../../db/schema";

export type AppSessionClientType = "web" | "native";
export type AppSessionRole = "customer" | "worker" | "admin";

export interface AppSessionCreateInput {
  id: string;
  userId: number;
  clientType: AppSessionClientType;
  tokenHash: string;
  csrfTokenHash: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface SessionUserRecord {
  id: number;
  role: AppSessionRole;
  isActive: boolean;
}

export interface StoredAppSession {
  id: string;
  userId: number;
  clientType: AppSessionClientType;
  tokenHash: string;
  csrfTokenHash: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  role: AppSessionRole;
  isActive: boolean;
}

export interface WorkerEligibilityRecord {
  status: "offline" | "available" | "busy" | "suspended";
  approvalStatus: "pending" | "approved" | "rejected";
  deletedAt: Date | null;
}

export interface SessionRepositoryPort {
  findUser(userId: number): Promise<SessionUserRecord | null>;
  create(input: AppSessionCreateInput): Promise<{
    id: string;
    expiresAt: Date;
  }>;
  findById(id: string): Promise<StoredAppSession | null>;
  markUsed(id: string, lastUsedAt: Date): Promise<boolean>;
  updateCsrfTokenHash(
    id: string,
    csrfTokenHash: string,
    now: Date,
  ): Promise<boolean>;
  findWorkerProfile(userId: number): Promise<WorkerEligibilityRecord | null>;
  revoke(id: string, revokedAt: Date): Promise<void>;
  revokeAllForUser(userId: number, revokedAt: Date): Promise<void>;
}

export class SessionRepository implements SessionRepositoryPort {
  async findUser(userId: number): Promise<SessionUserRecord | null> {
    const [user] = await db
      .select({
        id: users.id,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, userId));

    return user ?? null;
  }

  async create(input: AppSessionCreateInput): Promise<{
    id: string;
    expiresAt: Date;
  }> {
    const [session] = await db.insert(appSessions).values(input).returning({
      id: appSessions.id,
      expiresAt: appSessions.expiresAt,
    });

    return session;
  }

  async findById(id: string): Promise<StoredAppSession | null> {
    const [session] = await db
      .select({
        id: appSessions.id,
        userId: appSessions.userId,
        clientType: appSessions.clientType,
        tokenHash: appSessions.tokenHash,
        csrfTokenHash: appSessions.csrfTokenHash,
        expiresAt: appSessions.expiresAt,
        revokedAt: appSessions.revokedAt,
        role: users.role,
        isActive: users.isActive,
      })
      .from(appSessions)
      .innerJoin(users, eq(users.id, appSessions.userId))
      .where(eq(appSessions.id, id));

    return session ?? null;
  }

  async markUsed(id: string, lastUsedAt: Date): Promise<boolean> {
    const updated = await db
      .update(appSessions)
      .set({ lastUsedAt })
      .where(
        and(
          eq(appSessions.id, id),
          isNull(appSessions.revokedAt),
          gt(appSessions.expiresAt, lastUsedAt),
        ),
      )
      .returning({ id: appSessions.id });
    return updated.length === 1;
  }

  async updateCsrfTokenHash(
    id: string,
    csrfTokenHash: string,
    now: Date,
  ): Promise<boolean> {
    const updated = await db
      .update(appSessions)
      .set({ csrfTokenHash })
      .where(
        and(
          eq(appSessions.id, id),
          eq(appSessions.clientType, "web"),
          isNull(appSessions.revokedAt),
          gt(appSessions.expiresAt, now),
        ),
      )
      .returning({ id: appSessions.id });
    return updated.length === 1;
  }

  async findWorkerProfile(
    userId: number,
  ): Promise<WorkerEligibilityRecord | null> {
    const [worker] = await db
      .select({
        status: workerProfiles.status,
        approvalStatus: workerProfiles.approvalStatus,
        deletedAt: workerProfiles.deletedAt,
      })
      .from(workerProfiles)
      .where(eq(workerProfiles.userId, userId));

    return worker ?? null;
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    await db
      .update(appSessions)
      .set({ revokedAt })
      .where(and(eq(appSessions.id, id), isNull(appSessions.revokedAt)));
  }

  async revokeAllForUser(userId: number, revokedAt: Date): Promise<void> {
    await db
      .update(appSessions)
      .set({ revokedAt })
      .where(
        and(eq(appSessions.userId, userId), isNull(appSessions.revokedAt)),
      );
  }
}
