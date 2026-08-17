import { FastifyInstance } from "fastify";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";
import { AllocationOfferService } from "./allocation-offer.service";

export async function registerAllocationRoutes(app: FastifyInstance) {
  const acceptanceService = new AllocationAcceptanceService();
  const offerService = new AllocationOfferService();

  
  app.post("/bookings/:bookingId/offer", async (request, reply) => {
    const { bookingId } = request.params as { bookingId: string };
    const body = request.body as {
      workerId: number;
      tier: string;
      ttlSeconds: number;
    };

    const offer = await offerService.createOffer(
      Number(bookingId),
      body.workerId,
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
    const body = request.body as { workerId: number };

    const accepted = await acceptanceService.accept(
      Number(bookingId),
      body.workerId
    );

    if (!accepted) {
      return reply.status(409).send({
        message: "Offer is no longer available",
      });
    }

    return reply.send({ message: "Offer accepted" });
  });
}
