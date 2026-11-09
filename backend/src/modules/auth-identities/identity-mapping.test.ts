import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../db";
import { authIdentities, users, workerProfiles } from "../../db/schema";
import { UsersRepository } from "../users/users.repository";
import { IdentityRepository } from "./identity.repository";
import { IdentityMappingService } from "./identity-mapping.service";

const identityRepository = new IdentityRepository();
const identityService = new IdentityMappingService(identityRepository);
const usersRepository = new UsersRepository();

let fixtureCounter = 0;
const fixtureUserIds: number[] = [];

const createUser = async (
  role: "customer" | "worker" | "admin" = "customer",
  isActive = true,
) => {
  fixtureCounter += 1;
  const [user] = await db
    .insert(users)
    .values({
      phoneNumber: `+1${Date.now()}${fixtureCounter}`,
      fullName: "Identity mapping test user",
      role,
      isActive,
    })
    .returning();

  fixtureUserIds.push(user.id);
  return user;
};

const createIdentity = () => ({
  issuer: "https://pronto-test.us.auth0.com/",
  subject: `auth0|Identity-${fixtureCounter}-${Date.now()}`,
});

const selfAuthorization = (
  userId: number,
  role: "customer" | "worker" | "admin" = "customer",
) => ({
  authenticatedUser: { userId, role },
  targetUserId: userId,
});

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

describe("Auth0 external identity mapping", () => {
  it("creates an identity mapping", async () => {
    const user = await createUser();
    const identity = createIdentity();

    const mapping = await identityService.linkIdentityToUser(
      identity,
      selfAuthorization(user.id),
    );

    expect(mapping.userId).toBe(user.id);
    expect(mapping.issuer).toBe(identity.issuer);
    expect(mapping.subject).toBe(identity.subject);
  });

  it("finds an identity by its exact issuer and subject", async () => {
    const user = await createUser();
    const identity = createIdentity();
    await identityRepository.createIdentityMapping(identity, user.id);

    await expect(
      identityRepository.findByIssuerAndSubject(
        identity.issuer,
        identity.subject,
      ),
    ).resolves.toMatchObject({
      userId: user.id,
      issuer: identity.issuer,
      subject: identity.subject,
    });
  });

  it("finds an identity by local user ID", async () => {
    const user = await createUser();
    const identity = createIdentity();
    await identityRepository.createIdentityMapping(identity, user.id);

    await expect(
      identityRepository.findByUserId(user.id),
    ).resolves.toMatchObject({
      issuer: identity.issuer,
      subject: identity.subject,
    });
  });

  it("rejects a duplicate issuer and subject mapping", async () => {
    const user = await createUser();
    const identity = createIdentity();
    await identityRepository.createIdentityMapping(identity, user.id);

    await expect(
      identityRepository.createIdentityMapping(identity, user.id),
    ).rejects.toMatchObject({
      reason: "identity_already_linked",
    });
  });

  it("rejects a second identity for the same user", async () => {
    const user = await createUser();
    await identityRepository.createIdentityMapping(createIdentity(), user.id);

    await expect(
      identityRepository.createIdentityMapping(createIdentity(), user.id),
    ).rejects.toMatchObject({
      reason: "user_already_has_identity",
    });
  });

  it("rejects linking an identity already owned by another user", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const admin = await createUser("admin");
    const identity = createIdentity();
    await identityService.linkIdentityToUser(
      identity,
      selfAuthorization(owner.id),
    );

    await expect(
      identityService.linkIdentityToUser(identity, {
        authenticatedUser: { userId: admin.id, role: "admin" },
        targetUserId: otherUser.id,
      }),
    ).rejects.toMatchObject({
      reason: "identity_already_linked",
    });
  });

  it("does not allow a non-admin to link an identity to another user", async () => {
    const user = await createUser();
    const otherUser = await createUser();

    await expect(
      identityService.linkIdentityToUser(createIdentity(), {
        authenticatedUser: { userId: user.id, role: "customer" },
        targetUserId: otherUser.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps a single owner when concurrent users link the same identity", async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    const identity = createIdentity();

    const attempts = await Promise.allSettled([
      identityService.linkIdentityToUser(
        identity,
        selfAuthorization(firstUser.id),
      ),
      identityService.linkIdentityToUser(
        identity,
        selfAuthorization(secondUser.id),
      ),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    await expect(
      db
        .select({ id: authIdentities.id })
        .from(authIdentities)
        .where(eq(authIdentities.subject, identity.subject)),
    ).resolves.toHaveLength(1);

    const [mapping] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.subject, identity.subject));
    expect([firstUser.id, secondUser.id]).toContain(mapping.userId);
  });

  it("returns an explicit not-linked result for unknown identities", async () => {
    await expect(
      identityService.resolveIdentity(createIdentity()),
    ).resolves.toEqual({ status: "not_linked" });
  });

  it("does not create a user during identity lookup", async () => {
    const userCreation = vi.spyOn(UsersRepository.prototype, "createUser");

    await identityService.resolveIdentity(createIdentity());

    expect(userCreation).not.toHaveBeenCalled();
  });

  it("does not change user role or account status during lookup", async () => {
    const user = await createUser("worker", false);
    const identity = createIdentity();
    await identityRepository.createIdentityMapping(identity, user.id);

    await identityService.resolveIdentity(identity);

    await expect(usersRepository.findUserById(user.id)).resolves.toMatchObject({
      role: "worker",
      isActive: false,
    });
  });

  it("keeps existing users without an identity mapping valid", async () => {
    const user = await createUser();

    await expect(identityRepository.findByUserId(user.id)).resolves.toBeNull();
    await expect(usersRepository.findUserById(user.id)).resolves.toMatchObject({
      id: user.id,
      phoneNumber: user.phoneNumber,
    });
  });

  it("leaves an existing worker profile unchanged", async () => {
    const user = await createUser("worker");
    const [profile] = await db
      .insert(workerProfiles)
      .values({
        userId: user.id,
        bio: "Existing worker profile for identity mapping",
        status: "available",
      })
      .returning();
    const identity = createIdentity();

    await identityService.linkIdentityToUser(
      identity,
      selfAuthorization(user.id),
    );
    await identityService.resolveIdentity(identity);

    await expect(
      db
        .select()
        .from(workerProfiles)
        .where(eq(workerProfiles.userId, user.id)),
    ).resolves.toEqual([profile]);
  });
});
