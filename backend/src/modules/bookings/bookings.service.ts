import { NotFoundError } from "../../shared/core/errors/not-found-error";

import { BookingsRepository } from "./bookings.repository";
import { UsersRepository } from "../users/users.repository";
import { ServicesRepository } from "../service-categories/services.repository";
import { AllocationService } from "../allocation/allocation.service";

import type {
  BookingResponse,
  CreateBookingInput,
  BookingWithCandidatesResponse,
} from "./bookings.types";

export class BookingsService {
  constructor(
    private readonly bookingsRepository: BookingsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly servicesRepository: ServicesRepository,
    private readonly allocationService: AllocationService
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

  async getWorkerBookings(workerId: number) {
    return this.bookingsRepository.findWorkerBookings(
      workerId
    );
  }
}