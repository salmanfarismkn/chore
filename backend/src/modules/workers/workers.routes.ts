import { FastifyInstance } from "fastify";

import { UsersRepository } from "../users/users.repository";

import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import { createWorkerSchema } from "./workers.schema";
import type { AuthUser } from "../auth/auth.types";

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

  server.post("/", { preHandler: [server.authenticate] }, async (request, reply) => {
    if ((request.user as AuthUser).role !== "admin") {
      return reply.status(403).send({ message: "Forbidden" });
    }

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

  server.get("/", { preHandler: [server.authenticate] }, async (request, reply) => {
    if ((request.user as AuthUser).role !== "admin") {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return workersService.getAllWorkers();
  });

  server.get("/:id", { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as {
      id: string;
    };

    const actor = request.user as AuthUser;
    const workerId = Number(id);
    const worker =
      await workersService.getWorkerById(
        workerId
      );

    if (!worker) {
      return reply.status(404).send({
        message: "Worker not found",
      });
    }

    if (actor.role !== "admin" && actor.userId !== worker.userId) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return worker;
  });
  server.patch("/:id", { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as {
        id: string;
    };

    const existing = await workersService.getWorkerById(Number(id));
    const actor = request.user as AuthUser;
    if (!existing) {
      return reply.status(404).send({ message: "Worker not found" });
    }
    if (actor.role !== "admin" && actor.userId !== existing.userId) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    const worker =
        await workersService.updateWorker(
            Number(id),
            request.body as any
        );

    return reply.send(worker);
  });
  
  server.delete("/:id", { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as {
        id: string;
    };

    const existing = await workersService.getWorkerById(Number(id));
    const actor = request.user as AuthUser;
    if (!existing) {
      return reply.status(404).send({ message: "Worker not found" });
    }
    if (actor.role !== "admin" && actor.userId !== existing.userId) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    const worker =
        await workersService.deleteWorker(
            Number(id)
        );

    return reply.send(worker);
  });
}