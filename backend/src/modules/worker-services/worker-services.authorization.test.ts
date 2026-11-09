import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../auth/auth.types";
import { WorkersRepository } from "../workers/workers.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import { WorkerServicesRepository } from "./worker-services.repository";
import { registerWorkerServiceRoutes } from "./worker-services.routes";
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
app.decorate("requireWorker", async (request, reply) => {
  if (request.user.role !== "worker" && request.user.role !== "admin") {
    reply.status(403).send({ message: "Forbidden" });
  }
});
const testRateLimitCounter: RateLimitCounter = async () => ({
  count: 1,
  ttlMs: 60_000,
});
app.register(registerWorkerServiceRoutes, {
  prefix: "/v1/worker-services",
  rateLimitCounter: testRateLimitCounter,
});

describe("Worker-service route authorization", () => {
  const workerFind = vi.spyOn(WorkersRepository.prototype, "findWorkerByUserId");
  const workerFindById = vi.spyOn(WorkersRepository.prototype, "findWorkerById");
  const serviceFind = vi.spyOn(ServicesRepository.prototype, "findServiceById");
  const serviceFindPair = vi.spyOn(WorkerServicesRepository.prototype, "findWorkerService");
  const create = vi.spyOn(WorkerServicesRepository.prototype, "createWorkerService");
  const listForWorker = vi.spyOn(WorkerServicesRepository.prototype, "findServicesForWorker");

  beforeEach(() => {
    workerFind.mockReset();
    workerFindById.mockReset();
    serviceFind.mockReset();
    serviceFindPair.mockReset();
    create.mockReset();
    listForWorker.mockReset();
    workerFind.mockResolvedValue({ id: 20, userId: 101 } as never);
    workerFindById.mockResolvedValue({ id: 101, userId: 101 } as never);
    serviceFind.mockResolvedValue({ id: 5 } as never);
    serviceFindPair.mockResolvedValue(null as never);
    create.mockResolvedValue({ workerId: 101, serviceCategoryId: 5, isActive: true, createdAt: new Date(), updatedAt: new Date() });
    listForWorker.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("allows a worker to manage only their own service and rejects cross-worker creation", async () => {
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/worker-services",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
      payload: { workerId: 101, serviceCategoryId: 5, price: 100 },
    });
    expect(allowed.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/worker-services",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
      payload: { workerId: 202, serviceCategoryId: 5, price: 100 },
    });
    expect(denied.statusCode).toBe(403);

    const workerListAllowed = await app.inject({
      method: "GET",
      url: "/v1/worker-services/worker/101",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
    });
    expect(workerListAllowed.statusCode).toBe(200);

    const workerListDenied = await app.inject({
      method: "GET",
      url: "/v1/worker-services/worker/202",
      headers: { "x-user-id": "101", "x-user-role": "worker" },
    });
    expect(workerListDenied.statusCode).toBe(403);
  });

  it("rejects anonymous access", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/worker-services" });
    expect(response.statusCode).toBe(401);
  });
});
