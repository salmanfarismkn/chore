import { db } from "../../db";
import { bookings } from "../../db/schema";
import { eq } from "drizzle-orm";

import { BookingsRepository } from "../bookings/bookings.repository";
import { AllocationLockService } from "./allocation-lock.service";
import { AllocationOfferService } from "./allocation-offer.service";
import { AllocationService } from "./allocation.service";
import { TepService } from "./tep.service";
import { AllocationRecoveryService } from "./allocation-recovery.service";
import { AllocationRepository } from "./allocation.repository";
import { AllocationLeaseService } from "./allocation-lease.service";

export function startAllocationRecoveryWorker(): void {
  const bookingsRepository = new BookingsRepository();
  const allocationLockService =
    new AllocationLockService();
  const allocationOfferService =
    new AllocationOfferService();
  const allocationRepository = new AllocationRepository();
  const allocationLeaseService = new AllocationLeaseService();

  const allocationService = new AllocationService(
    allocationRepository,
    bookingsRepository
  );

  const tepService = new TepService(
    allocationService,
    allocationOfferService,
    bookingsRepository,
    allocationLockService,
    allocationLeaseService
  );


  const recoveryService =
    new AllocationRecoveryService(
      bookingsRepository,
      allocationLockService,
      allocationOfferService,
      tepService
    );

  setInterval(async () => {
    try {
      const activeBookings = await db
        .select({
          id: bookings.id,
        })
        .from(bookings)
        .where(eq(bookings.status, "ALLOCATING"));

      for (const booking of activeBookings) {
        await recoveryService.recoverBooking(
          booking.id
        );
      }
    } catch (error) {
      console.error(
        "Allocation recovery failed:",
        error
      );
    }
  }, 30_000);
}