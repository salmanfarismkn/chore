import { FastifyInstance } from "fastify";

import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";
import { createUserSchema } from "./users.schema";

export async function registerUserRoutes(
  server: FastifyInstance
) {
  const usersRepository = new UsersRepository();
  const usersService = new UsersService(usersRepository);

  server.post("/", async (request, reply) => {
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

  server.get("/", async () => {
    return usersService.getAllUsers();
  });

  server.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const user = await usersService.getUserById(Number(id));

    if (!user) {
      return reply.status(404).send({
        message: "User not found",
      });
    }

    return user;
  });
}