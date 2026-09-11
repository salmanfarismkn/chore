import { FastifyInstance } from "fastify";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";
import { AllocationAssignmentService } from "./allocation-assignment.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { BookingsRepository } from "../bookings/bookings.repository";

export async function registerAllocationRoutes(app: FastifyInstance) {
  const acceptanceService = new AllocationAcceptanceService();
  const assignmentService = new AllocationAssignmentService(
    new BookingsRepository(),
    acceptanceService
  );
  const offerService = new AllocationOfferService();

  app.post("/bookings/:bookingId/offer", async (request, reply) => {
    const { bookingId } = request.params as { bookingId: string };
    const body = request.body as {
      userId?: number;
      workerId?: number;
      tier?: string;
      ttlSeconds?: number;
    };

    const workerId = body.userId ?? body.workerId;

    if (!workerId || !body.tier || !body.ttlSeconds) {
      return reply.status(400).send({ message: "Missing required fields" });
    }

    const offer = await offerService.createOffer(
      Number(bookingId),
      workerId,
      body.tier,
      body.ttlSeconds
    );

    if (!offer) {
      return reply.status(409).send({ message: "Offer could not be created" });
    }

    return reply.status(201).send(offer);
  });

  app.post("/bookings/:bookingId/accept", async (request, reply) => {
    const { bookingId } = request.params as { bookingId: string };
    const body = request.body as { userId?: number; workerId?: number };
    const workerId = body.userId ?? body.workerId;

    if (!workerId) {
      return reply.status(400).send({ message: "Missing worker id" });
    }

    try {
      const accepted = await assignmentService.acceptOffer(
        Number(bookingId),
        workerId
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
  });
}
