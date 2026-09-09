import { FastifyInstance } from "fastify";

import { BookingsRepository } from "./bookings.repository";
import { BookingsService } from "./bookings.service";
import { createBookingSchema } from "./bookings.schema";

import { UsersRepository } from "../users/users.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import { AllocationRepository } from "../allocation/allocation.repository";
import { AllocationService } from "../allocation/allocation.service";
import { IdempotencyRepository } from "../idempotency/idempotency.repository";
import { IdempotencyService } from "../idempotency/idempotency.service";

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

  const idempotencyService = new IdempotencyService(
    new IdempotencyRepository()
  );

  const bookingsService = new BookingsService(
    bookingsRepository,
    usersRepository,
    servicesRepository,
    allocationService,
    undefined as never
  );

  app.post(
    "/",
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const user = request.user as {
        userId: number;
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

      return reply.status(201).send(booking);
    }
  );


    app.get("/", async () => {
      return bookingsService.getAllBookings();
    });

  app.get("/customer/:customerId", async (request) => {
    const { customerId } =
      request.params as {
        customerId: string;
      };

    return bookingsService.getCustomerBookings(
      Number(customerId)
    );
  });

  app.get("/worker/:workerId", async (request) => {
    const { workerId } =
      request.params as {
        workerId: string;
      };

    return bookingsService.getWorkerBookings(
      Number(workerId)
    );
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

  
  app.get("/:id", async (request) => {
    const { id } =
      request.params as {
        id: string;
      };
      

    return bookingsService.getBooking(
      Number(id)
    );
  });
}