import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../auth/auth.types";
import { registerWorkerRoutes } from "./workers.routes";
import { WorkersRepository } from "./workers.repository";
import { UsersRepository } from "../users/users.repository";

const app = Fastify();
app.decorate(
  "authenticate",
  async (request, reply) => {
    const userId = Number(request.headers["x-user-id"]);
    const role = request.headers["x-user-role"];

    if (
      !Number.isInteger(userId) ||
      (role !== "worker" && role !== "admin")
    ) {
      reply.status(401).send({ message: "Unauthorized" });
      return;
    }

    request.user = { userId, role } as AuthUser;
  }
);
app.register(registerWorkerRoutes, { prefix: "/v1/workers" });

describe("Worker profile updates", () => {
  const profile = {
    id: 20,
    userId: 101,
    bio: "Original worker profile bio",
    averageRating: 4.8,
    completedJobs: 10,
    latitude: null,
    longitude: null,
    status: "available" as
      | "offline"
      | "available"
      | "busy"
      | "suspended",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const findWorker = vi.spyOn(WorkersRepository.prototype, "findWorkerById");
  const updateWorker = vi.spyOn(WorkersRepository.prototype, "updateWorker");
  const findAllWorkers = vi.spyOn(WorkersRepository.prototype, "findAllWorkers");
  const findWorkerByUserId = vi.spyOn(WorkersRepository.prototype, "findWorkerByUserId");
  const createWorker = vi.spyOn(WorkersRepository.prototype, "createWorker");
  const deleteWorker = vi.spyOn(WorkersRepository.prototype, "deleteWorker");
  const findUserById = vi.spyOn(UsersRepository.prototype, "findUserById");

  beforeEach(() => {
    profile.bio = "Original worker profile bio";
    profile.status = "available";
    findWorker.mockClear();
    updateWorker.mockClear();
    findAllWorkers.mockReset();
    findWorkerByUserId.mockReset();
    createWorker.mockReset();
    deleteWorker.mockReset();
    findUserById.mockReset();
    findAllWorkers.mockResolvedValue([profile] as never);
    findWorkerByUserId.mockResolvedValue(null as never);
    findUserById.mockResolvedValue({ id: 101, role: "worker" } as never);
    createWorker.mockResolvedValue(profile as never);
    deleteWorker.mockResolvedValue(profile as never);
    findWorker.mockImplementation(async () => profile);
    updateWorker.mockImplementation(async (_id, data) => {
      Object.assign(profile, data);
      return profile;
    });
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("restricts worker creation and listing to admins and rejects anonymous access", async () => {
    const adminCreate = await app.inject({
      method: "POST",
      url: "/v1/workers",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
      payload: { userId: 101, bio: "A valid worker profile biography" },
    });
    expect(adminCreate.statusCode).toBe(201);

    const adminList = await app.inject({
      method: "GET",
      url: "/v1/workers",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
    });
    expect(adminList.statusCode).toBe(200);

    const deniedCreate = await app.inject({
      method: "POST",
      url: "/v1/workers",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
      payload: { userId: 101, bio: "A valid worker profile biography" },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedList = await app.inject({
      method: "GET",
      url: "/v1/workers",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
    });
    expect(deniedList.statusCode).toBe(403);

    expect((await app.inject({ method: "POST", url: "/v1/workers", payload: { userId: 101, bio: "A valid worker profile biography" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/workers" })).statusCode).toBe(401);
  });

  it("allows owner/admin worker deletion and rejects other workers", async () => {
    const owner = await app.inject({
      method: "DELETE",
      url: "/v1/workers/20",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
    });
    expect(owner.statusCode).toBe(200);

    const admin = await app.inject({
      method: "DELETE",
      url: "/v1/workers/20",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
    });
    expect(admin.statusCode).toBe(200);

    const denied = await app.inject({
      method: "DELETE",
      url: "/v1/workers/20",
      headers: { "x-user-id": "202", "x-user-role": "worker" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("allows worker detail access only to the owner/admin", async () => {
    const owner = await app.inject({
      method: "GET",
      url: "/v1/workers/20",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
    });
    expect(owner.statusCode).toBe(200);

    const admin = await app.inject({
      method: "GET",
      url: "/v1/workers/20",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
    });
    expect(admin.statusCode).toBe(200);

    const denied = await app.inject({
      method: "GET",
      url: "/v1/workers/20",
      headers: { "x-user-id": "202", "x-user-role": "worker" },
    });
    expect(denied.statusCode).toBe(403);

    expect((await app.inject({ method: "GET", url: "/v1/workers/20" })).statusCode).toBe(401);
  });

  it("rejects worker status changes while allowing profile bio edits", async () => {
    const statusResponse = await app.inject({
      method: "PATCH",
      url: "/v1/workers/20",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
      payload: { status: "suspended" },
    });

    expect(statusResponse.statusCode).toBe(400);
    expect(profile.status).toBe("available");
    expect(updateWorker).not.toHaveBeenCalled();

    const bioResponse = await app.inject({
      method: "PATCH",
      url: "/v1/workers/20",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
      payload: { bio: "Updated worker profile bio" },
    });

    expect(bioResponse.statusCode).toBe(200);
    expect(bioResponse.json().bio).toBe("Updated worker profile bio");
    expect(profile.bio).toBe("Updated worker profile bio");
    expect(profile.status).toBe("available");
  });

  it("rejects edits to another worker's profile", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/workers/20",
      headers: { "x-user-id": "202", "x-user-role": "worker" },
      payload: { bio: "Unauthorized worker profile edit" },
    });

    expect(response.statusCode).toBe(403);
    expect(updateWorker).not.toHaveBeenCalled();
  });

  it("allows an admin to manage worker status", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/workers/20",
      headers: { "x-user-id": "101", "x-user-role": "admin" },
      payload: { status: "suspended" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("suspended");
    expect(profile.status).toBe("suspended");
  });
});
