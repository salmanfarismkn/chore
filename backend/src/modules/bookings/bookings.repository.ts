import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { bookings } from "../../db/schema";

import type {
  BookingResponse,
  CreateBookingInput,
} from "./bookings.types";

export class BookingsRepository {
  async createBooking(
    data: CreateBookingInput
  ): Promise<BookingResponse> {
    const [booking] = await db
      .insert(bookings)
      .values({
        customerId: data.customerId,
        workerId: null,
        serviceCategoryId: data.serviceCategoryId,
        status: "pending",
        scheduledAt: data.scheduledAt,
        estimatedPrice: data.estimatedPrice.toString(),
        finalPrice: null,
        otp: null,
      })
      .returning();

    return {
      ...booking,
      estimatedPrice: Number(booking.estimatedPrice),
    } as BookingResponse;
  }

  async findBookingById(id: number) {
    const [booking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, id));

    return booking ?? null;
  }

  async findCustomerBookings(customerId: number) {
    return db
      .select()
      .from(bookings)
      .where(eq(bookings.customerId, customerId));
  }

  async findWorkerBookings(workerId: number) {
    return db
      .select()
      .from(bookings)
      .where(eq(bookings.workerId, workerId));
  }

  async updateBookingWorker(
    bookingId: number,
    workerId: number
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        workerId,
        status: "assigned",
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    return booking ?? null;
  }

  async updateBookingStatus(
    bookingId: number,
    status:
      | "pending"
      | "assigned"
      | "en_route"
      | "working"
      | "completed"
      | "cancelled"
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        status,
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    return booking ?? null;
  }
}