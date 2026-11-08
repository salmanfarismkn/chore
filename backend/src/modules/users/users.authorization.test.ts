import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../auth/auth.types";
import { UsersRepository } from "./users.repository";
import { registerUserRoutes } from "./users.routes";
import type { RateLimitCounter } from "../../config/rate-limit";

const app = Fastify();
app.decorate("authenticate", async (request, reply) => {
  const userId = Number(request.headers["x-user-id"]);
  const role = request.headers["x-user-role"];
  if (!Number.isInteger(userId) || !["customer", "worker", "admin"].includes(String(role))) {
    return reply.status(401).send({ message: "Unauthorized" });
  }
  request.user = { userId, role } as AuthUser;
});
const testRateLimitCounter: RateLimitCounter = async () => ({
  count: 1,
  ttlMs: 60_000,
});
app.register(registerUserRoutes, {
  prefix: "/v1/users",
  rateLimitCounter: testRateLimitCounter,
});

describe("User route authorization", () => {
  const findUser = vi.spyOn(UsersRepository.prototype, "findUserById");
  const findAll = vi.spyOn(UsersRepository.prototype, "findAllUsers");
  const create = vi.spyOn(UsersRepository.prototype, "createUser");
  const findPhone = vi.spyOn(UsersRepository.prototype, "findUserByPhoneNumber");

  beforeEach(async () => {
    await app.ready();
    findUser.mockReset();
    findAll.mockReset();
    create.mockReset();
    findPhone.mockReset();
    findPhone.mockResolvedValue(null as never);
    findUser.mockImplementation(async (id) => id === 101 ? {
      id: 101,
      phoneNumber: "+15550000001",
      fullName: "Owner",
      role: "customer",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never : null as never);
    findAll.mockResolvedValue([] as never);
    create.mockResolvedValue({ id: 1, phoneNumber: "+15550000002", fullName: "Created", role: "customer" } as never);
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("allows admins to create and list users but rejects customers", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
      payload: { phoneNumber: "+15550000002", fullName: "Created", role: "customer" },
    });
    expect(createResponse.statusCode).toBe(201);

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
    });
    expect(listResponse.statusCode).toBe(200);

    const deniedCreate = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { "x-user-id": "101", "x-user-role": "customer" },
      payload: { phoneNumber: "+15550000002", fullName: "Created", role: "customer" },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedList = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: { "x-user-id": "101", "x-user-role": "customer" },
    });
    expect(deniedList.statusCode).toBe(403);
  });

  it("allows owner/admin detail access and rejects other users", async () => {
    const owner = await app.inject({
      method: "GET",
      url: "/v1/users/101",
      headers: { "x-user-id": "101", "x-user-role": "customer" },
    });
    expect(owner.statusCode).toBe(200);

    const admin = await app.inject({
      method: "GET",
      url: "/v1/users/101",
      headers: { "x-user-id": "1", "x-user-role": "admin" },
    });
    expect(admin.statusCode).toBe(200);

    const denied = await app.inject({
      method: "GET",
      url: "/v1/users/101",
      headers: { "x-user-id": "202", "x-user-role": "customer" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("rejects anonymous user operations", async () => {
    for (const request of [
      app.inject({ method: "POST", url: "/v1/users", payload: { phoneNumber: "+15550000002", fullName: "Created", role: "customer" } }),
      app.inject({ method: "GET", url: "/v1/users" }),
      app.inject({ method: "GET", url: "/v1/users/101" }),
    ]) {
      expect((await request).statusCode).toBe(401);
    }
  });
});
