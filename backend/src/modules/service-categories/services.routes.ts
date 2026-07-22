import { FastifyInstance } from "fastify";

import { ServicesRepository } from "./services.repository";
import { ServicesService } from "./services.service";
import { createServiceSchema } from "./services.schema";

export async function registerServiceRoutes(
  app: FastifyInstance
) {
  const repository =
    new ServicesRepository();

  const service =
    new ServicesService(repository);

  app.post("/", async (request, reply) => {
    const parsed =
      createServiceSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send(parsed.error);
    }

    const result =
      await service.createService(parsed.data);

    return reply.status(201).send(result);
  });

  app.get("/", async () => {
    return service.getAllServices();
  });

  app.get("/:id", async (request, reply) => {
    const { id } =
      request.params as { id: string };

    const result =
      await service.getServiceById(
        Number(id)
      );

    if (!result) {
      return reply.status(404).send({
        message: "Service not found",
      });
    }

    return result;
  });
}