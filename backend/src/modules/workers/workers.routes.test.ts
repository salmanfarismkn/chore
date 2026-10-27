import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../auth/auth.types";
import { registerWorkerRoutes } from "./workers.routes";
import { WorkersRepository } from "./workers.repository";

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

  beforeEach(() => {
    profile.bio = "Original worker profile bio";
    profile.status = "available";
    findWorker.mockClear();
    updateWorker.mockClear();
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
