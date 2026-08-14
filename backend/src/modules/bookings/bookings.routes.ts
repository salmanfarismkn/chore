import { FastifyInstance } from "fastify";

import { BookingsRepository } from "./bookings.repository";
import { BookingsService } from "./bookings.service";
import { createBookingSchema } from "./bookings.schema";

import { UsersRepository } from "../users/users.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import { AllocationRepository } from "../allocation/allocation.repository";
import { AllocationService } from "../allocation/allocation.service";


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
  const allocationService = new AllocationService(allocationRepository);

  const bookingsService = new BookingsService(
    bookingsRepository,
    usersRepository,
    servicesRepository,
    allocationService
  );

  app.post("/", async (request, reply) => {
    const parsed =
      createBookingSchema.safeParse(request.body);

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
        bookingData
      );

    return reply.status(201).send(booking);
  });

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