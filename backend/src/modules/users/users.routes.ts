import { FastifyInstance } from "fastify";

import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";
import { createUserSchema } from "./users.schema";
import type { AuthUser } from "../auth/auth.types";

export async function registerUserRoutes(
  server: FastifyInstance
) {
  const usersRepository = new UsersRepository();
  const usersService = new UsersService(usersRepository);

  server.post("/", { preHandler: [server.authenticate] }, async (request, reply) => {
    if ((request.user as AuthUser).role !== "admin") {
      return reply.status(403).send({ message: "Forbidden" });
    }

    const result = createUserSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        message: "Invalid request body",
        errors: result.error.flatten(),
      });
    }

    const user = await usersService.createUser(result.data);

    return reply.status(201).send(user);
  });

  server.get("/", { preHandler: [server.authenticate] }, async (request, reply) => {
    if ((request.user as AuthUser).role !== "admin") {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return usersService.getAllUsers();
  });

  server.get("/:id", { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.user as AuthUser;
    const userId = Number(id);

    if (actor.role !== "admin" && actor.userId !== userId) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    const user = await usersService.getUserById(userId);

    if (!user) {
      return reply.status(404).send({
        message: "User not found",
      });
    }

    return user;
  });
}