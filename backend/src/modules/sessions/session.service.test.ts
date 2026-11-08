import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AppSessionError, SessionService } from "./session.service";
import { SessionRepository } from "./session.repository";

type StoredSession = Parameters<SessionRepository["create"]>[0];

class MemorySessionRepository extends SessionRepository {
  readonly users = new Map<
    number,
    { id: number; role: "customer" | "worker" | "admin"; isActive: boolean }
  >();
  readonly sessions = new Map<
    string,
    StoredSession & { revokedAt: Date | null; lastUsedAt?: Date }
  >();
  readonly workers = new Map<
    number,
    {
      status: "offline" | "available" | "busy" | "suspended";
      approvalStatus: "pending" | "approved" | "rejected";
      deletedAt: Date | null;
    }
  >();

  override async findUser(userId: number) {
    return this.users.get(userId) ?? null;
  }

  override async create(input: StoredSession) {
    this.sessions.set(input.id, { ...input, revokedAt: null });
    return { id: input.id, expiresAt: input.expiresAt };
  }

  override async findById(id: string) {
    const stored = this.sessions.get(id);
    const user = stored && this.users.get(stored.userId);
    if (!stored || !user) {
      return null;
    }
    return {
      id: stored.id,
      userId: stored.userId,
      clientType: stored.clientType,
      tokenHash: stored.tokenHash,
      csrfTokenHash: stored.csrfTokenHash,
      expiresAt: stored.expiresAt,
      revokedAt: stored.revokedAt,
      role: user.role,
      isActive: user.isActive,
    };
  }

  override async markUsed(id: string, lastUsedAt: Date) {
    const stored = this.sessions.get(id);
    if (!stored || stored.revokedAt || stored.expiresAt <= lastUsedAt) {
      return false;
    }
    this.sessions.set(id, { ...stored, lastUsedAt });
    return true;
  }

  override async updateCsrfTokenHash(
    id: string,
    csrfTokenHash: string,
    now: Date,
  ) {
    const stored = this.sessions.get(id);
    if (!stored || stored.revokedAt || stored.expiresAt <= now) {
      return false;
    }
    this.sessions.set(id, { ...stored, csrfTokenHash });
    return true;
  }

  override async findWorkerProfile(userId: number) {
    return this.workers.get(userId) ?? null;
  }

  override async revoke(id: string, revokedAt: Date) {
    const stored = this.sessions.get(id);
    if (stored && !stored.revokedAt) {
      this.sessions.set(id, { ...stored, revokedAt });
    }
  }

  override async revokeAllForUser(userId: number, revokedAt: Date) {
    for (const [id, stored] of this.sessions) {
      if (stored.userId === userId && !stored.revokedAt) {
        this.sessions.set(id, { ...stored, revokedAt });
      }
    }
  }
}

describe("PostgreSQL-backed application session service", () => {
  it("creates distinct random credentials and persists only their one-way verifier", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(10, { id: 10, role: "customer", isActive: true });
    const service = new SessionService(repository, 3600);

    const first = await service.create(10, "native");
    const second = await service.create(10, "native");
    const stored = repository.sessions.get(first.id)!;

    expect(first.credential).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i);
    expect(first.credential).not.toBe(second.credential);
    expect(stored.tokenHash).toHaveLength(64);
    expect(stored.tokenHash).toBe(
      createHash("sha256")
        .update(first.credential.split(".")[1]!)
        .digest("hex"),
    );
    expect(stored.csrfTokenHash).toBeNull();
    expect(first.expiresAt.getTime()).toBe(
      stored.createdAt.getTime() + 3_600_000,
    );
  });

  it("does not create sessions for inactive or missing local users", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(11, { id: 11, role: "customer", isActive: false });
    const service = new SessionService(repository);

    await expect(service.create(11, "native")).rejects.toMatchObject({
      reason: "account_unavailable",
    });
    await expect(service.create(12, "native")).rejects.toMatchObject({
      reason: "account_unavailable",
    });
    expect(repository.sessions.size).toBe(0);
  });

  it("rejects expired, revoked, invalid, and mixed-client credentials", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(13, { id: 13, role: "customer", isActive: true });
    let now = 10_000;
    const service = new SessionService(repository, 300, () => now);
    const created = await service.create(13, "native");

    await expect(service.authenticate("bad", "native")).rejects.toBeInstanceOf(
      AppSessionError,
    );
    await expect(
      service.authenticate(created.credential, "web"),
    ).rejects.toMatchObject({ reason: "invalid_credential" });
    now += 300_000;
    await expect(
      service.authenticate(created.credential, "native"),
    ).rejects.toMatchObject({ reason: "invalid_credential" });
    now -= 300_000;
    await service.revoke(created.id);
    await expect(
      service.authenticate(created.credential, "native"),
    ).rejects.toMatchObject({ reason: "invalid_credential" });
  });

  it("applies revocation across independently constructed service instances", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(14, { id: 14, role: "customer", isActive: true });
    const firstInstance = new SessionService(repository);
    const secondInstance = new SessionService(repository);
    const created = await firstInstance.create(14, "native");

    await expect(
      secondInstance.authenticate(created.credential, "native"),
    ).resolves.toMatchObject({ userId: 14 });
    await firstInstance.revokeAllForUser(14);
    await expect(
      secondInstance.authenticate(created.credential, "native"),
    ).rejects.toMatchObject({ reason: "invalid_credential" });
  });

  it("uses the current local role and enforces worker profile, suspension, and availability", async () => {
    const repository = new MemorySessionRepository();
    const user: {
      id: number;
      role: "customer" | "worker" | "admin";
      isActive: boolean;
    } = { id: 15, role: "customer", isActive: true };
    repository.users.set(user.id, user);
    const service = new SessionService(repository);
    const created = await service.create(user.id, "native");

    user.role = "worker";
    await expect(
      service.authenticate(created.credential, "native"),
    ).resolves.toMatchObject({ role: "worker" });
    await expect(service.authorizeWorker(user.id)).rejects.toMatchObject({
      reason: "worker_unavailable",
    });

    repository.workers.set(user.id, {
      status: "suspended",
      approvalStatus: "approved",
      deletedAt: null,
    });
    await expect(service.authorizeWorker(user.id)).rejects.toMatchObject({
      reason: "worker_unavailable",
    });
    repository.workers.set(user.id, {
      status: "offline",
      approvalStatus: "approved",
      deletedAt: null,
    });
    await expect(service.authorizeWorker(user.id, true)).rejects.toMatchObject({
      reason: "worker_unavailable",
    });
    repository.workers.set(user.id, {
      status: "available",
      approvalStatus: "approved",
      deletedAt: null,
    });
    await expect(
      service.authorizeWorker(user.id, true),
    ).resolves.toBeUndefined();
  });

  it("denies pending and rejected profiles even when operational status is available", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(18, { id: 18, role: "worker", isActive: true });
    const service = new SessionService(repository);

    for (const approvalStatus of ["pending", "rejected"] as const) {
      repository.workers.set(18, {
        status: "available",
        approvalStatus,
        deletedAt: null,
      });
      await expect(service.authorizeWorker(18)).rejects.toMatchObject({
        reason: "worker_unavailable",
      });
      await expect(service.authorizeWorker(18, true)).rejects.toMatchObject({
        reason: "worker_unavailable",
      });
    }

    repository.workers.set(18, {
      status: "available",
      approvalStatus: "approved",
      deletedAt: null,
    });
    await expect(service.authorizeWorker(18, true)).resolves.toBeUndefined();
  });

  it("uses a single-use web CSRF verifier and supports token renewal", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(16, { id: 16, role: "customer", isActive: true });
    const service = new SessionService(repository);
    const created = await service.create(16, "web");
    const authenticated = await service.authenticate(created.credential, "web");

    expect(created.csrfToken).toBeTruthy();
    await expect(
      service.verifyCsrfToken(authenticated, created.csrfToken ?? undefined),
    ).resolves.toBe(true);

    const nextToken = await service.renewCsrfToken(created.id);
    const renewed = await service.authenticate(created.credential, "web");
    await expect(
      service.verifyCsrfToken(renewed, created.csrfToken ?? undefined),
    ).resolves.toBe(false);
    await expect(service.verifyCsrfToken(renewed, nextToken)).resolves.toBe(
      true,
    );
  });

  it("makes repeated logout revocation idempotent without accepting another secret", async () => {
    const repository = new MemorySessionRepository();
    repository.users.set(17, { id: 17, role: "customer", isActive: true });
    const service = new SessionService(repository);
    const created = await service.create(17, "native");
    await expect(
      service.revokeCredential(created.credential, "native"),
    ).resolves.toBe(true);
    await expect(
      service.revokeCredential(created.credential, "native"),
    ).resolves.toBe(true);
    await expect(
      service.revokeCredential(`${created.id}.${"A".repeat(43)}`, "native"),
    ).resolves.toBe(false);
    expect(repository.sessions.get(created.id)?.revokedAt).not.toBeNull();
  });
});
