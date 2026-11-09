import { FastifyInstance } from "fastify";

import { UsersRepository } from "../users/users.repository";

import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import {
  adminUpdateWorkerSchema,
  createWorkerSchema,
  updateWorkerSchema,
} from "./workers.schema";
import type { AuthUser } from "../auth/auth.types";
import { parsePositiveInteger } from "../../shared/validators/positive-integer";
import { z } from "zod";
import { AllocationOfferService } from "../allocation/allocation-offer.service";
import {
  InvalidWorkerApprovalTransitionError,
  WorkerApprovalActorUnauthorizedError,
  WorkerCannotDecideOwnApprovalError,
} from "./workers.repository";
import {
  createDistributedRateLimitPreHandler,
  RATE_LIMIT_POLICIES,
  type RateLimitCounter,
  userRateLimitIdentity,
} from "../../config/rate-limit";

const workerApprovalSchema = z
  .object({
    approvalStatus: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export async function registerWorkerRoutes(
  server: FastifyInstance,
  options: { rateLimitCounter?: RateLimitCounter } = {},
) {
  const usersRepository = new UsersRepository();

  const workersRepository = new WorkersRepository();

  const workersService = new WorkersService(workersRepository, usersRepository);
  const allocationOfferService = new AllocationOfferService();

  server.post(
    "/",
    {
      preHandler: [
        server.authenticate,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.adminWorkerCreation,
          (request) => userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      if ((request.user as AuthUser).role !== "admin") {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const result = createWorkerSchema.safeParse(request.body);

      if (!result.success) {
        return reply.status(400).send({
          message: "Invalid request body",
          errors: result.error.flatten(),
        });
      }

      const worker = await workersService.createWorker(result.data);

      return reply.status(201).send(worker);
    },
  );

  server.get(
    "/",
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      if ((request.user as AuthUser).role !== "admin") {
        return reply.status(403).send({ message: "Forbidden" });
      }

      return workersService.getAllWorkers();
    },
  );

  server.post(
    "/:id/approval",
    {
      preHandler: [
        server.authenticate,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.adminWorkerApproval,
          (request) => userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      const actor = request.user as AuthUser;
      if (actor.role !== "admin") {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const { id } = request.params as { id: string };
      const workerId = parsePositiveInteger(id);
      if (workerId === null) {
        return reply.status(400).send({ message: "Invalid worker id" });
      }
      const parsed = workerApprovalSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: "Invalid request body",
          errors: parsed.error.flatten(),
        });
      }

      try {
        const decision = await workersRepository.decideApproval(
          workerId,
          parsed.data.approvalStatus,
          actor.userId,
          parsed.data.reason,
        );
        if (!decision) {
          return reply.status(404).send({ message: "Worker not found" });
        }

        if (parsed.data.approvalStatus === "rejected") {
          try {
            await allocationOfferService.revokeWorkerOffers(
              decision.worker.userId,
            );
          } catch {
            request.log.error(
              "Worker offer revocation failed after approval change",
            );
            return reply.status(503).send({
              message: "Approval changed; outstanding offers are unavailable",
            });
          }
        }

        return reply.send(decision.worker);
      } catch (error) {
        if (error instanceof WorkerCannotDecideOwnApprovalError) {
          return reply.status(403).send({ message: "Forbidden" });
        }
        if (error instanceof WorkerApprovalActorUnauthorizedError) {
          return reply.status(403).send({ message: "Forbidden" });
        }
        if (error instanceof InvalidWorkerApprovalTransitionError) {
          return reply.status(409).send({
            message: "Invalid worker approval transition",
          });
        }
        throw error;
      }
    },
  );

  server.get(
    "/:id",
    { preHandler: [server.authenticate, server.requireWorker] },
    async (request, reply) => {
      const { id } = request.params as {
        id: string;
      };

      const actor = request.user as AuthUser;
      const workerId = parsePositiveInteger(id);
      if (workerId === null) {
        return reply.status(400).send({ message: "Invalid worker id" });
      }
      const worker = await workersService.getWorkerById(workerId);

      if (!worker) {
        return reply.status(404).send({
          message: "Worker not found",
        });
      }

      if (actor.role !== "admin" && actor.userId !== worker.userId) {
        return reply.status(403).send({ message: "Forbidden" });
      }

      return worker;
    },
  );
  server.patch(
    "/:id",
    {
      preHandler: [
        server.authenticate,
        server.requireWorker,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.workerProfileUpdate,
          (request) => userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      const { id } = request.params as {
        id: string;
      };
      const workerId = parsePositiveInteger(id);
      if (workerId === null) {
        return reply.status(400).send({ message: "Invalid worker id" });
      }

      const existing = await workersService.getWorkerById(workerId);
      const actor = request.user as AuthUser;
      if (!existing) {
        return reply.status(404).send({ message: "Worker not found" });
      }
      if (actor.role !== "admin" && actor.userId !== existing.userId) {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const schema =
        actor.role === "admin" ? adminUpdateWorkerSchema : updateWorkerSchema;
      const result = schema.safeParse(request.body);

      if (!result.success) {
        return reply.status(400).send({
          message: "Invalid request body",
          errors: result.error.flatten(),
        });
      }

      const worker = await workersService.updateWorker(workerId, result.data);

      return reply.send(worker);
    },
  );

  server.delete(
    "/:id",
    {
      preHandler: [
        server.authenticate,
        server.requireWorker,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.workerProfileDeletion,
          (request) => userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      const { id } = request.params as {
        id: string;
      };
      const workerId = parsePositiveInteger(id);
      if (workerId === null) {
        return reply.status(400).send({ message: "Invalid worker id" });
      }

      const existing = await workersService.getWorkerById(workerId);
      const actor = request.user as AuthUser;
      if (!existing) {
        return reply.status(404).send({ message: "Worker not found" });
      }
      if (actor.role !== "admin" && actor.userId !== existing.userId) {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const worker = await workersService.deleteWorker(workerId);

      return reply.send(worker);
    },
  );
}
