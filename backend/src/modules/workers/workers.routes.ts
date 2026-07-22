import { FastifyInstance } from "fastify";

import { UsersRepository } from "../users/users.repository";

import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import { createWorkerSchema } from "./workers.schema";

export async function registerWorkerRoutes(
  server: FastifyInstance
) {
  const usersRepository = new UsersRepository();

  const workersRepository =
    new WorkersRepository();

  const workersService =
    new WorkersService(
      workersRepository,
      usersRepository
    );

  server.post("/", async (request, reply) => {
    const result =
      createWorkerSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        message: "Invalid request body",
        errors: result.error.flatten(),
      });
    }

    const worker =
      await workersService.createWorker(result.data);

    return reply.status(201).send(worker);
  });

  server.get("/", async () => {
    return workersService.getAllWorkers();
  });

  server.get("/:id", async (request, reply) => {
    const { id } = request.params as {
      id: string;
    };

    const worker =
      await workersService.getWorkerById(
        Number(id)
      );

    if (!worker) {
      return reply.status(404).send({
        message: "Worker not found",
      });
    }

    return worker;
  });
  server.patch("/:id", async (request, reply) => {
    const { id } = request.params as {
        id: string;
    };

    const worker =
        await workersService.updateWorker(
            Number(id),
            request.body as any
        );

    return reply.send(worker);
  });
  
  server.delete("/:id", async (request, reply) => {
    const { id } = request.params as {
        id: string;
    };

    const worker =
        await workersService.deleteWorker(
            Number(id)
        );

    return reply.send(worker);
  });
}