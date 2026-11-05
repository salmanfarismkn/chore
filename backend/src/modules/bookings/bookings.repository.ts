import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db";
import { bookings, idempotencyKeys } from "../../db/schema";

import type {
  BookingResponse,
  CreateBookingInput,
} from "./bookings.types";
import { BookingStatus, canTransition } from "./booking-status";
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
      | "ACCEPTED"
      | "EN_ROUTE"
      | "WORKING"
      | "COMPLETED"
      | "CANCELLED"
      | "ALLOCATION_FAILED"
  ) {
    const existing = await this.findBookingById(bookingId);

    if (!existing) {
      return null;
    }

    const currentStatus = existing.status as BookingStatus;

    if (!canTransition(currentStatus, status as BookingStatus)) {
      throw new Error(
        `Invalid booking transition: ${currentStatus} -> ${status}`
      );
    }

    const [booking] = await db
      .update(bookings)
      .set({
        status,
        ...(status === "COMPLETED" ||
        status === "CANCELLED" ||
        status === "ALLOCATION_FAILED"
          ? { allocationReconciliationPending: true }
          : {}),
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    return booking ?? null;
  }

  async assignWorker(
    bookingId: number,
    workerId: number,
    allocationGeneration?: number
  ) {
    return db.transaction(async (tx) => {
      const [booking] = await tx
        .update(bookings)
        .set({
          workerId,
          status: "ASSIGNED",
          allocationReconciliationPending: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookings.id, bookingId),
            eq(bookings.status, "ALLOCATING"),
            ...(allocationGeneration === undefined
              ? []
              : [eq(bookings.allocationGeneration, allocationGeneration)])
          )
        )
        .returning();

      if (!booking) {
        throw new Error("Booking already assigned");
      }

      return booking;
    });
  }
  async getAllocationState(bookingId: number) {
    const [booking] = await db
      .select({
        id: bookings.id,
        serviceCategoryId: bookings.serviceCategoryId,
        workerId: bookings.workerId,
        status: bookings.status,
        allocationTier: bookings.allocationTier,
        allocationGeneration: bookings.allocationGeneration,
        allocationReconciliationPending:
          bookings.allocationReconciliationPending,
        pickupLatitude: bookings.pickupLatitude,
        pickupLongitude: bookings.pickupLongitude,
      })
      .from(bookings)
      .where(eq(bookings.id, bookingId));

    return booking ?? null;
  }

  async moveToNextAllocationTier(
    bookingId: number,
    nextTier: number,
    currentTier: number,
    allocationGeneration?: number
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
          eq(bookings.status, "ALLOCATING"),
          eq(bookings.allocationTier, currentTier),
          ...(allocationGeneration === undefined
            ? []
            : [eq(bookings.allocationGeneration, allocationGeneration)])
        )
      )
      .returning();

    return booking ?? null;
  }

  async markAllocationFailed(
    bookingId: number,
    allocationGeneration?: number
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        status: "ALLOCATION_FAILED",
        allocationReconciliationPending: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "ALLOCATING"),
          ...(allocationGeneration === undefined
            ? []
            : [eq(bookings.allocationGeneration, allocationGeneration)])
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
        allocationGeneration: sql`${bookings.allocationGeneration} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(bookings.id, bookingId), eq(bookings.status, "PENDING")))
      .returning();

    return booking ?? null;
  }

  async acquireAllocationGeneration(
    bookingId: number,
    currentGeneration: number
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        allocationGeneration: sql`${bookings.allocationGeneration} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "ALLOCATING"),
          eq(bookings.allocationGeneration, currentGeneration)
        )
      )
      .returning({ allocationGeneration: bookings.allocationGeneration });

    return booking?.allocationGeneration ?? null;
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
        ...(nextStatus === "COMPLETED" ||
        nextStatus === "CANCELLED" ||
        nextStatus === "ALLOCATION_FAILED"
          ? { allocationReconciliationPending: true }
          : {}),
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
        const racedRequest =
          await idempotencyRepository.findWithTransaction(
            tx,
            userId,
            idempotencyKey
          );

        if (racedRequest?.response) {
          return {
            booking: racedRequest.response,
            isExisting: true,
          };
        }

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
  async cancelBooking(
    bookingId: number,
    currentStatus: BookingStatus
  ) {
    type BookingDbStatus = (typeof bookings.status.enumValues)[number];

    return db.transaction(async (tx) => {
      const [booking] = await tx
        .update(bookings)
        .set({
          status: "CANCELLED" as BookingDbStatus,
          allocationReconciliationPending: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookings.id, bookingId),
            eq(bookings.status, currentStatus as BookingDbStatus)
          )
        )
        .returning();

      if (!booking) {
        throw new Error("Cancellation failed");
      }

      return booking;
    });
  }

  async completeBooking(bookingId: number) {
    const [booking] = await db
      .update(bookings)
      .set({
        status: "COMPLETED",
        allocationReconciliationPending: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.status, "WORKING")
        )
      )
      .returning();

    return booking ?? null;
  }

  async findPendingAllocationReconciliations() {
    return db
      .select({
        id: bookings.id,
        status: bookings.status,
        allocationGeneration: bookings.allocationGeneration,
      })
      .from(bookings)
      .where(eq(bookings.allocationReconciliationPending, true));
  }

  async clearAllocationReconciliation(
    bookingId: number,
    allocationGeneration: number
  ) {
    const [booking] = await db
      .update(bookings)
      .set({
        allocationReconciliationPending: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, bookingId),
          eq(bookings.allocationGeneration, allocationGeneration),
          eq(bookings.allocationReconciliationPending, true)
        )
      )
      .returning({ id: bookings.id });

    return booking ?? null;
  }
}