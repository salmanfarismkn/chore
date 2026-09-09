import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { bookings, idempotencyKeys } from "../../db/schema";

import type {
  BookingResponse,
  CreateBookingInput,
} from "./bookings.types";
import { BookingStatus } from "./booking-status";
import { IdempotencyRepository } from "../idempotency/idempotency.repository";

const idempotencyRepository = new IdempotencyRepository();

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
        status: "PENDING",
        allocationTier: 1,
        scheduledAt: data.scheduledAt,
        pickupLatitude: data.pickupLatitude,
        pickupLongitude: data.pickupLongitude,
        estimatedPrice: data.estimatedPrice.toString(),
        finalPrice: null,
        otp: null,

      })
      .returning();

  return {
    id: booking.id,
    customerId: booking.customerId,
    workerId: booking.workerId,
    serviceCategoryId: booking.serviceCategoryId,
    status: booking.status.toUpperCase() as BookingResponse["status"],
    allocationTier: booking.allocationTier,
    estimatedPrice: Number(booking.estimatedPrice),
    finalPrice: booking.finalPrice ? Number(booking.finalPrice) : null,
    otp: booking.otp,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };
  }

  async findBookingById(id: number) {
    const [booking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, id));

    return booking ?? null;
  }

  async findAllBookings() {
    return db
      .select()
      .from(bookings);
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
        status: "ASSIGNED",
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    return booking ?? null;
  }

  async updateBookingStatus(
    bookingId: number,
    status:
      | "PENDING"
      | "ALLOCATING"
      | "ASSIGNED"
      | "EN_ROUTE"
      | "WORKING"
      | "COMPLETED"
      | "CANCELLED"
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

  async assignWorker(
    bookingId: number,
    workerId: number
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        workerId,
        status: "ASSIGNED",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "ALLOCATING")
        )
      )
      .returning();

    return booking ?? null;
  }
  async getAllocationState(bookingId: number) {
    const [booking] = await db
      .select({
        id: bookings.id,
        serviceCategoryId: bookings.serviceCategoryId,
        workerId: bookings.workerId,
        status: bookings.status,
        allocationTier: bookings.allocationTier,
        pickupLatitude: bookings.pickupLatitude,
        pickupLongitude: bookings.pickupLongitude,
      })
      .from(bookings)
      .where(eq(bookings.id, bookingId));

    return booking ?? null;
  }

  async moveToNextAllocationTier(
    bookingId: number,
    nextTier: number
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        allocationTier: nextTier,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "ALLOCATING")
        )
      )
      .returning();

    return booking ?? null;
  }

  async markAllocationFailed(bookingId: number) {
    const [booking] = await db
      .update(bookings)
      .set({
        status: "CANCELLED",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "ALLOCATING")
        )
      )
      .returning();

    return booking ?? null;
  }
  
  async startAllocation(bookingId: number) {
    const [booking] = await db
      .update(bookings)
      .set({
        status: "ALLOCATING",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "PENDING")
        )
      )
      .returning();

    return booking ?? null;

  }

  async transitionStatus(
    bookingId: number,
    currentStatus: BookingStatus,
    nextStatus: BookingStatus
  ) {
    type BookingDbStatus = (typeof bookings.status.enumValues)[number];

    const [booking] = await db
      .update(bookings)
      .set({
        status: nextStatus as BookingDbStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, currentStatus as BookingDbStatus)
        )
      )
      .returning();

    return booking ?? null;
  }

  async createBookingWithIdempotency(
    data: CreateBookingInput,
    userId: number,
    idempotencyKey: string
  ) {
    return db.transaction(async (tx) => {
      const existing =
        await idempotencyRepository.findWithTransaction(
          tx,
          userId,
          idempotencyKey
        );

      if (existing) {
        return {
          booking: existing.response,
          isExisting: true,
        };
      }

      const reservation =
        await idempotencyRepository.createWithTransaction(
          tx,
          userId,
          idempotencyKey,
          {}
        );

      if (!reservation) {
        throw new Error(
          "Idempotency request is already being processed"
        );
      }

      const [booking] = await tx
        .insert(bookings)
        .values({
          customerId: data.customerId,
          workerId: null,
          serviceCategoryId: data.serviceCategoryId,
          status: "PENDING",
          allocationTier: 1,
          scheduledAt: data.scheduledAt,
          pickupLatitude: data.pickupLatitude,
          pickupLongitude: data.pickupLongitude,
          estimatedPrice: data.estimatedPrice.toString(),
          finalPrice: null,
          otp: null,
        })
        .returning();

      if (!booking) {
        throw new Error("Booking creation failed");
      }

      await tx
        .update(idempotencyKeys)
        .set({
          response: booking,
        })
        .where(eq(idempotencyKeys.id, reservation.id));

      return {
        booking,
        isExisting: false,
      };
    });
  }
}