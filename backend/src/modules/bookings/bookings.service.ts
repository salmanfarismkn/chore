import { NotFoundError } from "../../shared/core/errors/not-found-error";

import { BookingsRepository } from "./bookings.repository";
import { UsersRepository } from "../users/users.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import { AllocationService } from "../allocation/allocation.service";
import { AllocationLockService } from "../allocation/allocation-lock.service";

import type {
  BookingResponse,
  CreateBookingInput,
  BookingWithCandidatesResponse,
} from "./bookings.types";
import { BookingStatus, canTransition } from "./booking-status";

export class BookingsService {
  constructor(
    private readonly bookingsRepository: BookingsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly servicesRepository: ServicesRepository,
    private readonly allocationService: AllocationService,
    private readonly allocationLockService: AllocationLockService
  ) {}

  async createBooking(
    data: CreateBookingInput
  ): Promise<BookingWithCandidatesResponse> {
    const customer =
      await this.usersRepository.findUserById(
        data.customerId
      );

    if (!customer) {
      throw new NotFoundError("Customer not found");
    }

    const service =
      await this.servicesRepository.findServiceById(
        data.serviceCategoryId
      );

    if (!service) {
      throw new NotFoundError(
        "Service category not found"
      );
    }

    const booking = await this.bookingsRepository.createBooking({
      ...data,
      estimatedPrice: Number(service.basePrice),
    });

    // 4. Call AllocationService
    const rankedCandidates = await this.allocationService.allocate(
      data.serviceCategoryId,
      data.pickupLatitude,
      data.pickupLongitude
    );

    // 5. Return booking + ranked candidates
    return {
      ...booking,
      allocation: {
        candidates: rankedCandidates,
      },
    };
  }

  async getAllBookings() {
    return this.bookingsRepository.findAllBookings();
  }

  async getBooking(id: number) {
    const booking =
      await this.bookingsRepository.findBookingById(id);

    if (!booking) {
      throw new NotFoundError("Booking not found");
    }

    return booking;
  }

  async getCustomerBookings(customerId: number) {
    return this.bookingsRepository.findCustomerBookings(
      customerId
    );
  }

  async transitionBookingStatus(
    bookingId: number,
    nextStatus: BookingStatus
  ) {
    const booking = await this.bookingsRepository.findBookingById(
      bookingId
    );

    if (!booking) {
      throw new NotFoundError("Booking not found");
    }

    const currentStatus = booking.status as BookingStatus;

    if (!canTransition(currentStatus, nextStatus)) {
      throw new Error(
        `Invalid booking transition: ${currentStatus} -> ${nextStatus}`
      );
    }

    const updated =
      await this.bookingsRepository.transitionStatus(
        bookingId,
        currentStatus,
        nextStatus
      );

    if (!updated) {
      throw new Error("Booking status transition failed");
    }

    return updated;
  }

  async cancelBooking(bookingId: number) {
    const booking = 
      await this.bookingsRepository.findBookingById(
        bookingId
    );

    if (!booking) {
      throw new Error("Booking not found");
    }

    const currentStatus = booking.status as BookingStatus;

    if (!canTransition(currentStatus, "CANCELLED")) {
      throw new Error(
        `Booking cannot be cancelled from ${currentStatus}`
      );
    }

    const cancelled =
      await this.bookingsRepository.transitionStatus(
        bookingId,
        currentStatus,
        "CANCELLED"
      );

    if (!cancelled) {
      throw new Error("Booking cancellation failed");
    }

    // If allocation is running, stop the current winner/allocation state.
    if (currentStatus === "ALLOCATING") {
      const winner =
        await this.allocationLockService.getWinner(bookingId);

      if (winner !== null) {
        await this.allocationLockService.releaseWinner(
          bookingId,
          winner
        );
      }
    }

    return cancelled;
  }

  async getWorkerBookings(workerId: number) {
    return this.bookingsRepository.findWorkerBookings(
      workerId
    );
  }
}