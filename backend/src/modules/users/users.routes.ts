import { FastifyInstance } from "fastify";

import { UsersService } from "./users.service";
import { createUserSchema } from "./users.schema";

const usersService = new UsersService();

export async function registerUserRoutes(server: FastifyInstance) {
  server.post("/", async (request, reply) => {
    const result = createUserSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        message: "Invalid request body",
        errors: result.error.flatten(),
      });
    }

    try {
      const user = await usersService.createUser(result.data);

      return reply.status(201).send(user);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "USER_ALREADY_EXISTS"
      ) {
        return reply.status(409).send({
          message: "Phone number already exists",
        });
      }

      request.log.error(error);

      return reply.status(500).send({
        message: "Internal Server Error",
      });
    }
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