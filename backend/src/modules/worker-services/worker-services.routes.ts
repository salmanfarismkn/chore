import { FastifyInstance } from "fastify";

import { WorkerServicesRepository } from "./worker-services.repository";
import { WorkerServicesService } from "./worker-services.service";
import { createWorkerServiceSchema } from "./worker-services.schema";

import { WorkersRepository } from "../workers/workers.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import type { AuthUser } from "../auth/auth.types";

export async function registerWorkerServiceRoutes(
  app: FastifyInstance
) {
  const workerServicesRepository =
    new WorkerServicesRepository();

  const workersRepository =
    new WorkersRepository();

  const servicesRepository =
    new ServicesRepository();

  const workerServicesService =
    new WorkerServicesService(
      workerServicesRepository,
      workersRepository,
      servicesRepository
    );

  app.post("/", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed =
      createWorkerServiceSchema.safeParse(
        request.body
      );

    if (!parsed.success) {
      return reply.status(400).send({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
    }

    const actor = request.user as AuthUser;
    if (actor.role !== "admin" && actor.userId !== parsed.data.workerId) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    const result =
      await workerServicesService.createWorkerService(
        parsed.data
      );

    return reply.status(201).send(result);
  });

  app.get("/", { preHandler: [app.authenticate] }, async () => {
    return workerServicesService.getAllWorkerServices();
  });

  app.get("/worker/:workerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { workerId } = request.params as {
      workerId: string;
    };

    const actor = request.user as AuthUser;
    const requestedWorkerId = Number(workerId);
    if (actor.role !== "admin" && actor.userId !== requestedWorkerId) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return workerServicesService.getServicesForWorker(requestedWorkerId);
  });

  app.get("/service/:serviceId", { preHandler: [app.authenticate] }, async (request) => {
    const { serviceId } = request.params as {
      serviceId: string;
    };

    return workerServicesService.getWorkersForService(
      Number(serviceId)
    );
  });
}