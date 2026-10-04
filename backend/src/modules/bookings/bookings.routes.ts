import { FastifyInstance, FastifyReply } from "fastify";

import { BookingsRepository } from "./bookings.repository";
import { BookingsService } from "./bookings.service";
import { createBookingSchema } from "./bookings.schema";

import { UsersRepository } from "../users/users.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import { AllocationRepository } from "../allocation/allocation.repository";
import { AllocationService } from "../allocation/allocation.service";
import { AllocationLockService } from "../allocation/allocation-lock.service";
import { AllocationOfferService } from "../allocation/allocation-offer.service";
import { AllocationLeaseService } from "../allocation/allocation-lease.service";
import { TepService } from "../allocation/tep.service";
import { IdempotencyRepository } from "../idempotency/idempotency.repository";
import { IdempotencyService } from "../idempotency/idempotency.service";
import type { AuthUser } from "../auth/auth.types";

export async function registerBookingRoutes(
  app: FastifyInstance
) {
  const bookingsRepository =
    new BookingsRepository();

  const usersRepository =
    new UsersRepository();

  const servicesRepository =
    new ServicesRepository();

  const allocationRepository = new AllocationRepository();
  const allocationService = new AllocationService(
      allocationRepository,
      bookingsRepository   
    );
  const allocationLockService = new AllocationLockService();
  const tepService = new TepService(
    allocationService,
    new AllocationOfferService(),
    bookingsRepository,
    allocationLockService,
    new AllocationLeaseService()
  );

  const idempotencyService = new IdempotencyService(
    new IdempotencyRepository()
  );

  const bookingsService = new BookingsService(
    bookingsRepository,
    usersRepository,
    servicesRepository,
    allocationService,
    allocationLockService
  );

  const authorizeAssignedWorker = async (
    userId: number,
    role: string,
    bookingId: number,
    reply: FastifyReply
  ): Promise<boolean> => {
    if (role !== "worker") {
      reply.status(403).send({ message: "Forbidden" });
      return false;
    }

    const booking = await bookingsRepository.findBookingById(bookingId);

    if (!booking) {
      reply.status(404).send({ message: "Booking not found" });
      return false;
    }

    if (booking.workerId !== userId) {
      reply.status(403).send({ message: "Forbidden" });
      return false;
    }

    return true;
  };

  app.post(
    "/",
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const user = request.user as {
        userId: number;
        role: string;
      };

      const idempotencyKey =
        request.headers["idempotency-key"];

      if (
        typeof idempotencyKey !== "string" ||
        !idempotencyKey.trim()
      ) {
        return reply.status(400).send({
          message: "Idempotency-Key header is required",
        });
      }

      const parsed = createBookingSchema.safeParse(
        request.body
      );

      if (!parsed.success) {
        return reply.status(400).send({
          message: "Invalid request body",
          errors: parsed.error.flatten(),
        });
      }

      if (user.role !== "customer" || user.userId !== parsed.data.customerId) {
        return reply.status(403).send({ message: "Forbidden" });
      }

      const existing = await idempotencyService.getExisting(
        user.userId,
        idempotencyKey
      );

      if (existing?.response) {
        return reply.status(200).send(existing.response);
      }

      const bookingData = {
        ...parsed.data,
        estimatedPrice: 0,
      };

      const booking =
        await bookingsService.createBooking(
          bookingData,
          user.userId,
          idempotencyKey
        );

      await tepService.startAllocation(
        booking.id,
        booking.serviceCategoryId
      );

      return reply.status(201).send(booking);
    }
  );


  app.get("/", { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as AuthUser;

    if (user.role !== "admin") {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return bookingsService.getAllBookings();
  });

  app.get("/customer/:customerId", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { customerId } =
      request.params as {
        customerId: string;
      };

    const requestedCustomerId = Number(customerId);

    const user = request.user as AuthUser;

    if (
      user.role !== "admin" &&
      (user.role !== "customer" || user.userId !== requestedCustomerId)
    ) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return bookingsService.getCustomerBookings(requestedCustomerId);
  });

  app.get("/worker/:workerId", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { workerId } =
      request.params as {
        workerId: string;
      };

    const requestedWorkerId = Number(workerId);

    const user = request.user as AuthUser;

    if (
      user.role !== "admin" &&
      (user.role !== "worker" || user.userId !== requestedWorkerId)
    ) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return bookingsService.getWorkerBookings(requestedWorkerId);
  });

  app.post("/:id/cancel", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user as {
      userId: number;
      role: Parameters<BookingsService["cancelBooking"]>[2];
    };

    try {
      const booking = await bookingsService.cancelBooking(
        Number(id),
        user.userId,   
        user.role      
      );

      return reply.send(booking);
    } catch (error) {
      return reply.status(400).send({
        message:
          error instanceof Error
            ? error.message
            : "Unable to cancel booking",
      });
    }
  });

  app.post("/:id/accept", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user as AuthUser;
    if (!(await authorizeAssignedWorker(
      user.userId,
      user.role,
      Number(id),
      reply
    ))) return;

    return bookingsService.transitionBookingStatus(
      Number(id),
      "ACCEPTED"
    );
  });

  app.post("/:id/en-route", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user as AuthUser;
    if (!(await authorizeAssignedWorker(
      user.userId,
      user.role,
      Number(id),
      reply
    ))) return;

    return bookingsService.transitionBookingStatus(
      Number(id),
      "EN_ROUTE"
    );
  });

  app.post("/:id/start", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user as AuthUser;
    if (!(await authorizeAssignedWorker(
      user.userId,
      user.role,
      Number(id),
      reply
    ))) return;

    return bookingsService.transitionBookingStatus(
      Number(id),
      "WORKING"
    );
  });

  app.post("/:id/complete", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user as AuthUser;
    if (!(await authorizeAssignedWorker(
      user.userId,
      user.role,
      Number(id),
      reply
    ))) return;

    return bookingsService.transitionBookingStatus(
      Number(id),
      "COMPLETED"
    );
  });
  
  app.get("/:id", {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } =
      request.params as {
        id: string;
      };
      

    const booking = await bookingsService.getBooking(Number(id));
    const user = request.user as AuthUser;
    const canRead =
      user.role === "admin" ||
      (user.role === "customer" && booking.customerId === user.userId) ||
      (user.role === "worker" && booking.workerId === user.userId);

    if (!canRead) {
      return reply.status(403).send({ message: "Forbidden" });
    }

    return booking;
  });
}