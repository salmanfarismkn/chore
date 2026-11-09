import { FastifyInstance } from "fastify";

import { ServicesRepository } from "./services.repository";
import { ServicesService } from "./services.service";
import { createServiceSchema } from "./services.schema";
import type { AuthUser } from "../auth/auth.types";
import { parsePositiveInteger } from "../../shared/validators/positive-integer";
import {
  createDistributedRateLimitPreHandler,
  RATE_LIMIT_POLICIES,
  userRateLimitIdentity,
  type RateLimitCounter,
} from "../../config/rate-limit";

export async function registerServiceRoutes(
  app: FastifyInstance,
  options: { rateLimitCounter?: RateLimitCounter } = {},
) {
  const repository =
    new ServicesRepository();

  const service =
    new ServicesService(repository);

  app.post(
    "/",
    {
      preHandler: [
        app.authenticate,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.adminServiceCreation,
          (request) => userRateLimitIdentity(request.user?.userId),
          options.rateLimitCounter,
        ),
      ],
    },
    async (request, reply) => {
      if ((request.user as AuthUser).role !== "admin") {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const parsed = createServiceSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send(parsed.error);
      }

      const result = await service.createService(parsed.data);

      return reply.status(201).send(result);
    },
  );

  app.get("/", { preHandler: [app.authenticate] }, async () => {
    return service.getAllServices();
  });

  app.get("/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } =
      request.params as { id: string };
    const serviceId = parsePositiveInteger(id);
    if (serviceId === null) {
      return reply.status(400).send({ message: "Invalid service id" });
    }

    const result =
      await service.getServiceById(
        serviceId
      );

    if (!result) {
      return reply.status(404).send({
        message: "Service not found",
      });
    }

    return result;
  });
}