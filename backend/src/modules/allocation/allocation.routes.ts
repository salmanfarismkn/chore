import { FastifyInstance } from "fastify";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";
import { AllocationAssignmentService } from "./allocation-assignment.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { BookingsRepository } from "../bookings/bookings.repository";
import type { AuthUser } from "../auth/auth.types";
import { parsePositiveInteger } from "../../shared/validators/positive-integer";
import { z } from "zod";
import {
  createDistributedRateLimitPreHandler,
  RATE_LIMIT_POLICIES,
  userRateLimitIdentity,
} from "../../config/rate-limit";

const offerSchema = z
  .object({
    userId: z.number().int().positive().optional(),
    workerId: z.number().int().positive().optional(),
    tier: z.string().trim().min(1).max(50),
    ttlSeconds: z.number().int().min(1).max(3600),
  })
  .refine(
    (value) => value.userId !== undefined || value.workerId !== undefined,
  );

export async function registerAllocationRoutes(app: FastifyInstance) {
  const acceptanceService = new AllocationAcceptanceService();
  const assignmentService = new AllocationAssignmentService(
    new BookingsRepository(),
    acceptanceService,
  );
  const bookingsRepository = new BookingsRepository();
  const offerService = new AllocationOfferService();

  app.post(
    "/bookings/:bookingId/offer",
    {
      preHandler: [
        app.authenticate,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.adminOfferCreation,
          (request) => userRateLimitIdentity(request.user?.userId),
        ),
      ],
    },
    async (request, reply) => {
      const actor = request.user as AuthUser;

      if (actor.role !== "admin") {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const { bookingId } = request.params as { bookingId: string };
      const parsedBookingId = parsePositiveInteger(bookingId);
      if (parsedBookingId === null) {
        return reply.status(400).send({ message: "Invalid booking id" });
      }
      const parsed = offerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: "Invalid request body",
          errors: parsed.error.flatten(),
        });
      }
      const workerId = parsed.data.userId ?? parsed.data.workerId;
      if (workerId === undefined) {
        return reply.status(400).send({ message: "Missing worker id" });
      }

      const offer = await offerService.createOffer(
        parsedBookingId,
        workerId,
        parsed.data.tier,
        parsed.data.ttlSeconds,
      );

      if (!offer) {
        return reply
          .status(409)
          .send({ message: "Offer could not be created" });
      }

      return reply.status(201).send(offer);
    },
  );

  app.post(
    "/bookings/:bookingId/accept",
    {
      preHandler: [
        app.authenticate,
        app.requireAvailableWorker,
        createDistributedRateLimitPreHandler(
          RATE_LIMIT_POLICIES.allocationOfferAcceptance,
          (request) => userRateLimitIdentity(request.user?.userId),
        ),
      ],
    },
    async (request, reply) => {
      const actor = request.user as AuthUser;

      if (actor.role !== "worker") {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const { bookingId } = request.params as { bookingId: string };
      const parsedBookingId = parsePositiveInteger(bookingId);
      if (parsedBookingId === null) {
        return reply.status(400).send({ message: "Invalid booking id" });
      }
      const workerId = actor.userId;

      try {
        const allocationState =
          await bookingsRepository.getAllocationState(parsedBookingId);

        if (!allocationState || allocationState.status !== "ALLOCATING") {
          return reply.status(409).send({
            message: "Offer is no longer available",
          });
        }

        const accepted = await assignmentService.acceptOffer(
          parsedBookingId,
          workerId,
          allocationState.allocationGeneration,
        );

        if (!accepted) {
          return reply.status(409).send({
            message: "Offer is no longer available",
          });
        }

        return reply.status(200).send(accepted);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Assignment failed";

        return reply.status(409).send({
          message,
        });
      }
    },
  );
}
