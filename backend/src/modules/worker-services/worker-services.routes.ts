import { FastifyInstance } from "fastify";

import { WorkerServicesRepository } from "./worker-services.repository";
import { WorkerServicesService } from "./worker-services.service";
import { createWorkerServiceSchema } from "./worker-services.schema";

import { WorkersRepository } from "../workers/workers.repository";
import { ServicesRepository } from "../service-categories/services.repository";

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

  app.post("/", async (request, reply) => {
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

    const result =
      await workerServicesService.createWorkerService(
        parsed.data
      );

    return reply.status(201).send(result);
  });

  app.get("/", async () => {
    return workerServicesService.getAllWorkerServices();
  });

  app.get("/worker/:workerId", async (request) => {
    const { workerId } = request.params as {
      workerId: string;
    };

    return workerServicesService.getServicesForWorker(
      Number(workerId)
    );
  });

  app.get("/service/:serviceId", async (request) => {
    const { serviceId } = request.params as {
      serviceId: string;
    };

    return workerServicesService.getWorkersForService(
      Number(serviceId)
    );
  });
}