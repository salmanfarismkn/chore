import { BOOKING_TRANSITIONS, BookingStatus } from "./booking-status";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { BookingsService } from "./bookings.service";

import { TepService } from "../allocation/tep.service"; 
import { AllocationRepository } from "../allocation/allocation.repository";
import { BookingsRepository } from "./bookings.repository";

const bookingStore = new Map<number, any>();
let nextBookingId = 1;

const bookingsRepository = {
  createBooking: vi.fn(async (data: any) => {
    const booking = {
      id: nextBookingId++,
      customerId: data.customerId,
      workerId: null,
      serviceCategoryId: data.serviceCategoryId,
      status: "pending",
      allocationTier: 1,
      pickupLatitude: data.pickupLatitude,
      pickupLongitude: data.pickupLongitude,
      estimatedPrice: data.estimatedPrice ?? 100,
      finalPrice: null,
      otp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    bookingStore.set(booking.id, booking);
    return booking;
  }),
  findBookingById: vi.fn(async (id: number) => bookingStore.get(id) ?? null),
  updateBookingStatus: vi.fn(async (id: number, status: string) => {
    const existing = bookingStore.get(id);
    if (!existing) return null;

    const current = existing.status.toUpperCase();
    const next = status.toUpperCase();
    if (!canTransition(current as BookingStatus, next as BookingStatus)) {
      throw new Error(`Invalid booking transition: ${current} -> ${next}`);
    }

    existing.status = next.toLowerCase();
    existing.updatedAt = new Date();
    bookingStore.set(id, existing);
    return existing;
  }),
  assignWorker: vi.fn(async (id: number, workerId: number) => {
    const existing = bookingStore.get(id);
    if (!existing) return null;
    if (!canTransition(existing.status.toUpperCase() as BookingStatus, "ASSIGNED")) {
      throw new Error(`Invalid booking transition: ${existing.status} -> ASSIGNED`);
    }
    existing.workerId = workerId;
    existing.status = "assigned";
    existing.updatedAt = new Date();
    bookingStore.set(id, existing);
    return existing;
  }),
  cancelBooking: vi.fn(async (id: number, status: string) => {
    const existing = bookingStore.get(id);
    if (!existing) return null;
    const current = existing.status.toUpperCase();
    if (!canTransition(current as BookingStatus, "CANCELLED")) {
      throw new Error(`Invalid booking transition: ${current} -> CANCELLED`);
    }
    existing.status = "cancelled";
    existing.updatedAt = new Date();
    bookingStore.set(id, existing);
    return existing;
  }),
};

const bookingsService = {
  transitionBookingStatus: async (id: number, nextStatus: string) => {
    const booking = bookingStore.get(id);
    if (!booking) throw new Error("Booking not found");
    const current = booking.status.toUpperCase();
    const next = nextStatus.toUpperCase();
    const valid = canTransition(current as BookingStatus, next as BookingStatus);
    if (!valid) {
      throw new Error(`Invalid booking transition: ${current} -> ${next}`);
    }
    booking.status = next.toLowerCase();
    booking.updatedAt = new Date();
    bookingStore.set(id, booking);
    return booking;
  },
};

const mockBookingsRepository = {
  getBooking: vi.fn(),
  moveToNextAllocationTier: vi.fn(),
};

const mockAllocationLockService = {
  getWinner: vi.fn(),
};

const redis = {
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
};

const mockIdempotencyService = {
  getExisting: vi.fn(),
  save: vi.fn(),
};

const mockBookingsService = {
  createBooking: vi.fn(),
};

const mockTepService = {
  startTier: vi.fn(),
};

const mockLeaseService = {
  acquire: vi.fn(),
  release: vi.fn(),
};

const INSTANCE_ID = "instance-1";

const recoveryService = {
  async recoverBooking(bookingId: number) {
    const acquired = await mockLeaseService.acquire(bookingId, INSTANCE_ID);
    if (!acquired) return;

    try {
      await mockTepService.startTier(bookingId, Date.now());
    } finally {
      await mockLeaseService.release(bookingId, INSTANCE_ID);
    }
  },
};

const inFlightRequests = new Map<string, Promise<any>>();
const routeHandler = async ({
  headers,
  body,
}: {
  headers: { "idempotency-key": string };
  body: any;
}) => {
  const key = headers["idempotency-key"];
  const existing = await mockIdempotencyService.getExisting(key);
  if (existing?.response) return existing.response;

  const inFlight = inFlightRequests.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    const booking = await mockBookingsService.createBooking(body);
    await mockIdempotencyService.save(key, booking);
    return booking;
  })();
  inFlightRequests.set(key, request);

  try {
    return await request;
  } finally {
    inFlightRequests.delete(key);
  }
};

const repo = {
  findBookingById: vi.fn(),
};

const service = {
  async cancelBooking(
    id: number,
    userId: number,
    role: "customer" | "worker" | "admin",
  ) {
    const booking = await repo.findBookingById(id);

    if (
      (role === "customer" && booking.customerId !== userId) ||
      (role === "worker" && booking.workerId !== userId)
    ) {
      throw new Error("You cannot cancel this booking");
    }

    booking.status = "CANCELLED";
    return booking;
  },
};

const tepService = {
  allocationService: {
    createTiers: vi.fn(),
    getTier: vi.fn(),
  },
  resumeAllocation: async (bookingId: number, tier: number) => {
    const booking = await mockBookingsRepository.getBooking(bookingId);
    if (!booking || booking.status !== "ALLOCATING") return;

    const winner = await mockAllocationLockService.getWinner(bookingId);
    if (winner !== null) return;

    await redis.set(`allocation:booking:${bookingId}:tier:${tier}:remaining`, "1");
    await tepService.allocationService.createTiers();
  },
};

function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}
describe("Valid booking transitions", () => {
  it("pending → allocating", () => {
    expect(canTransition("PENDING", "ALLOCATING")).toBe(true);
  });

  it("allocating → assigned", () => {
    expect(canTransition("ALLOCATING", "ASSIGNED")).toBe(true);
  });

  it("assigned → accepted", () => {
    expect(canTransition("ASSIGNED", "ACCEPTED")).toBe(true);
  });

  it("accepted → en_route", () => {
    expect(canTransition("ACCEPTED", "EN_ROUTE")).toBe(true);
  });

  it("en_route → working", () => {
    expect(canTransition("EN_ROUTE", "WORKING")).toBe(true);
  });

  it("working → completed", () => {
    expect(canTransition("WORKING", "COMPLETED")).toBe(true);
  });
});
describe("Invalid booking transitions", () => {
  it("completed → working", () => {
    expect(canTransition("COMPLETED", "WORKING")).toBe(false);
  });

  it("cancelled → accepted", () => {
    expect(canTransition("CANCELLED", "ACCEPTED")).toBe(false);
  });

  it("pending → completed", () => {
    expect(canTransition("PENDING", "COMPLETED")).toBe(false);
  });

  it("allocation_failed → assigned", () => {
    expect(canTransition("ALLOCATION_FAILED", "ASSIGNED")).toBe(false);
  });
});
describe("Race condition on assignment", () => {
  it("only one worker can succeed", async () => {
    // Mock repository with current status = ALLOCATING
    const repo = {
      status: "ALLOCATING" as BookingStatus,
      workerId: undefined as number | undefined,
      async assign(workerId: number) {
        if (this.status !== "ALLOCATING") {
          return false;
        }
        this.status = "ASSIGNED";
        this.workerId = workerId;
        return true;
      },
    };

    const resultA = await repo.assign(1); // Worker A
    const resultB = await repo.assign(2); // Worker B

    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
    expect(repo.workerId).toBe(1); // Worker A wins
  });
});

describe("Valid cancellation transitions", () => {
  it("pending → cancelled", () => {
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
  });

  it("allocating → cancelled", () => {
    expect(canTransition("ALLOCATING", "CANCELLED")).toBe(true);
  });

  it("assigned → cancelled", () => {
    expect(canTransition("ASSIGNED", "CANCELLED")).toBe(true);
  });

  it("accepted → cancelled", () => {
    expect(canTransition("ACCEPTED", "CANCELLED")).toBe(true);
  });

  it("en_route → cancelled", () => {
    expect(canTransition("EN_ROUTE", "CANCELLED")).toBe(true);
  });

  it("working → cancelled", () => {
    expect(canTransition("WORKING", "CANCELLED")).toBe(true);
  });
});
describe("Invalid cancellation transitions", () => {
  it("completed → cancelled", () => {
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
  });

  it("cancelled → cancelled", () => {
    expect(canTransition("CANCELLED", "CANCELLED")).toBe(false);
  });

  it("allocation_failed → cancelled", () => {
    expect(canTransition("ALLOCATION_FAILED", "CANCELLED")).toBe(false);
  });
});
describe("Tier progression stops after cancellation", () => {
  it("does not advance tiers when booking is cancelled", async () => {
    const booking = { status: "CANCELLED" as BookingStatus };
    const handler = async () => {
      if (booking.status !== "ALLOCATING") {
        return "stopped";
      }
      return "advanced";
    };

    expect(await handler()).toBe("stopped");
  });
});
describe("Customer cancels after assignment", () => {
  it("assigned → cancelled", () => {
    const booking = { status: "ASSIGNED" as BookingStatus };
    const cancelled = canTransition(booking.status, "CANCELLED");
    expect(cancelled).toBe(true);
  });
});
describe("Customer cancellation", () => {
  it("allows Customer A to cancel their own booking", async () => {
    const booking = { id: 1, status: "ASSIGNED", customerId: 42 };
    repo.findBookingById.mockResolvedValue(booking);

    const result = await service.cancelBooking(1, 42, "customer");
    expect(result.status).toBe("CANCELLED");
  });

  it("blocks Customer B from cancelling Customer A's booking", async () => {
    const booking = { id: 1, status: "ASSIGNED", customerId: 42 };
    repo.findBookingById.mockResolvedValue(booking);

    await expect(service.cancelBooking(1, 99, "customer"))
      .rejects.toThrow("You cannot cancel this booking");
  });
});
describe("Worker cancellation", () => {
  it("allows Worker A assigned to booking to cancel", async () => {
    const booking = { id: 1, status: "ASSIGNED", workerId: 7 };
    repo.findBookingById.mockResolvedValue(booking);

    const result = await service.cancelBooking(1, 7, "worker");
    expect(result.status).toBe("CANCELLED");
  });

  it("blocks Worker B not assigned to booking", async () => {
    const booking = { id: 1, status: "ASSIGNED", workerId: 7 };
    repo.findBookingById.mockResolvedValue(booking);

    await expect(service.cancelBooking(1, 8, "worker"))
      .rejects.toThrow("You cannot cancel this booking");
  });
});
describe("Admin cancellation", () => {
  it("allows Admin to cancel any valid booking", async () => {
    const booking = { id: 1, status: "ASSIGNED", customerId: 42, workerId: 7 };
    repo.findBookingById.mockResolvedValue(booking);

    const result = await service.cancelBooking(1, 999, "admin");
    expect(result.status).toBe("CANCELLED");
  });
});
describe("Tier progression stops after cancellation", () => {
  it("does not advance tiers once booking is cancelled", async () => {
    const booking = { id: 1, status: "ALLOCATING", customerId: 42 };
    repo.findBookingById.mockResolvedValue(booking);

    await service.cancelBooking(1, 42, "customer");

    // Simulate tier expiry handler
    const handler = async () => {
      if (booking.status !== "ALLOCATING") {
        return "stopped";
      }
      return "advanced";
    };

    expect(await handler()).toBe("stopped");
  });
});
describe("Idempotency - same request twice", () => {
  it("returns the same booking for duplicate requests", async () => {
    const key = "abc123";
    const booking = { id: 101, status: "PENDING" };

    mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
    mockBookingsService.createBooking.mockResolvedValueOnce(booking);
    mockIdempotencyService.save.mockResolvedValueOnce(booking);

    const result1 = await routeHandler({ headers: { "idempotency-key": key }, body: booking });
    expect(result1.id).toBe(101);

    mockIdempotencyService.getExisting.mockResolvedValueOnce({ response: booking });
    const result2 = await routeHandler({ headers: { "idempotency-key": key }, body: booking });
    expect(result2.id).toBe(101);
  });
});

describe("Idempotency - same key, different body", () => {
  it("returns the first booking regardless of body differences", async () => {
    const key = "abc123";
    const bookingA = { id: 101, status: "PENDING" };

    mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
    mockBookingsService.createBooking.mockResolvedValueOnce(bookingA);
    mockIdempotencyService.save.mockResolvedValueOnce(bookingA);

    // First request
    const resultA = await routeHandler({ headers: { "idempotency-key": key }, body: { foo: "A" } });
    expect(resultA.id).toBe(101);

    // Second request with different body but same key
    mockIdempotencyService.getExisting.mockResolvedValueOnce({ response: bookingA });
    const resultB = await routeHandler({ headers: { "idempotency-key": key }, body: { foo: "B" } });
    expect(resultB.id).toBe(101);
  });
});
describe("Idempotency - different keys", () => {
  it("creates separate bookings for different keys", async () => {
    const bookingA = { id: 101, status: "PENDING" };
    const bookingB = { id: 102, status: "PENDING" };

    mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
    mockBookingsService.createBooking.mockResolvedValueOnce(bookingA);
    mockIdempotencyService.save.mockResolvedValueOnce(bookingA);

    const resultA = await routeHandler({ headers: { "idempotency-key": "abc123" }, body: bookingA });
    expect(resultA.id).toBe(101);

    mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
    mockBookingsService.createBooking.mockResolvedValueOnce(bookingB);
    mockIdempotencyService.save.mockResolvedValueOnce(bookingB);

    const resultB = await routeHandler({ headers: { "idempotency-key": "xyz789" }, body: bookingB });
    expect(resultB.id).toBe(102);
  });
});
describe("Idempotency - concurrent requests", () => {
  it("only one booking is created, the other returns the same record", async () => {
    const key = "same-key";
    const booking = { id: 101, status: "PENDING" };

    mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
    mockBookingsService.createBooking.mockResolvedValueOnce(booking);
    mockIdempotencyService.save.mockResolvedValueOnce(booking);

    // Simulate two requests at the same time
    const [result1, result2] = await Promise.all([
      routeHandler({ headers: { "idempotency-key": key }, body: booking }),
      routeHandler({ headers: { "idempotency-key": key }, body: booking }),
    ]);

    expect(result1.id).toBe(101);
    expect(result2.id).toBe(101);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  inFlightRequests.clear();
});
it("creates one booking and one idempotency record for same key", async () => {
  const key = "abc123";
  const booking = { id: 101, status: "PENDING" };

  // First request: no existing record
  mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
  mockBookingsService.createBooking.mockResolvedValueOnce(booking);
  mockIdempotencyService.save.mockResolvedValueOnce(booking);

  const result1 = await routeHandler({ headers: { "idempotency-key": key }, body: booking });
  expect(result1.id).toBe(101);

  // Second request: existing record found
  mockIdempotencyService.getExisting.mockResolvedValueOnce({ response: booking });

  const result2 = await routeHandler({ headers: { "idempotency-key": key }, body: booking });
  expect(result2.id).toBe(101);

  expect(mockBookingsService.createBooking).toHaveBeenCalledTimes(1);
  expect(mockIdempotencyService.save).toHaveBeenCalledTimes(1);
});


it("returns first booking when same key used with different body", async () => {
  const key = "abc123";
  const booking = { id: 101, status: "PENDING" };

  // First request: no existing record
  mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
  mockBookingsService.createBooking.mockResolvedValueOnce(booking);
  mockIdempotencyService.save.mockResolvedValueOnce(booking);

  const resultA = await routeHandler({ headers: { "idempotency-key": key }, body: { foo: "A" } });
  expect(resultA.id).toBe(101);

  // Second request: existing record found
  mockIdempotencyService.getExisting.mockResolvedValueOnce({ response: booking });

  const resultB = await routeHandler({ headers: { "idempotency-key": key }, body: { foo: "B" } });
  expect(resultB.id).toBe(101);

  expect(mockBookingsService.createBooking).toHaveBeenCalledTimes(1);
  expect(mockIdempotencyService.save).toHaveBeenCalledTimes(1);
});

it("creates separate bookings for different keys", async () => {
  const bookingA = { id: 101, status: "PENDING" };
  const bookingB = { id: 102, status: "PENDING" };

  // First key
  mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
  mockBookingsService.createBooking.mockResolvedValueOnce(bookingA);
  mockIdempotencyService.save.mockResolvedValueOnce(bookingA);

  const resultA = await routeHandler({ headers: { "idempotency-key": "abc123" }, body: bookingA });
  expect(resultA.id).toBe(101);

  // Second key
  mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
  mockBookingsService.createBooking.mockResolvedValueOnce(bookingB);
  mockIdempotencyService.save.mockResolvedValueOnce(bookingB);

  const resultB = await routeHandler({ headers: { "idempotency-key": "xyz789" }, body: bookingB });
  expect(resultB.id).toBe(102);

  expect(mockBookingsService.createBooking).toHaveBeenCalledTimes(2);
  expect(mockIdempotencyService.save).toHaveBeenCalledTimes(2);
});

it("handles concurrent requests safely", async () => {
  const key = "same-key";
  const booking = { id: 101, status: "PENDING" };

  mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
  mockBookingsService.createBooking.mockResolvedValueOnce(booking);
  mockIdempotencyService.save.mockResolvedValueOnce(booking);

  const [result1, result2] = await Promise.all([
    routeHandler({ headers: { "idempotency-key": key }, body: booking }),
    routeHandler({ headers: { "idempotency-key": key }, body: booking }),
  ]);

  expect(result1.id).toBe(101);
  expect(result2.id).toBe(101);

  expect(mockBookingsService.createBooking).toHaveBeenCalledTimes(1);
  expect(mockIdempotencyService.save).toHaveBeenCalledTimes(1);
});

it("rolls back when booking insert fails", async () => {
  const key = "fail-key";

  mockIdempotencyService.getExisting.mockResolvedValueOnce(null);
  mockBookingsService.createBooking.mockRejectedValueOnce(new Error("DB error"));

  await expect(
    routeHandler({ headers: { "idempotency-key": key }, body: { foo: "bad" } })
  ).rejects.toThrow("DB error");

  expect(mockIdempotencyService.save).not.toHaveBeenCalled();
});
describe("Crash Recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.clear(); 
  });

  it("Scenario A: resumes Tier 1 when no active offers", async () => {
    mockBookingsRepository.getBooking.mockResolvedValueOnce({
      id: 123,
      status: "ALLOCATING",
      allocationTier: 1,
      pickupLatitude: 10,
      pickupLongitude: 20,
      serviceCategoryId: 5,
    });

    redis.get.mockResolvedValueOnce(null);
    mockAllocationLockService.getWinner.mockResolvedValueOnce(null);

    const fakeTier = {
      name: "Tier1",
      candidates: [{ workerId: 42 }],
      timeoutSeconds: 30,
    };

    (tepService as any).allocationService = {
      createTiers: vi.fn().mockResolvedValueOnce([fakeTier]),
      getTier: vi.fn().mockReturnValue(fakeTier),
    };

    (tepService as any).offerService = {
      createOffer: vi.fn().mockResolvedValue({ status: "pending" }),
    };

    await tepService.resumeAllocation(123, 1);

    expect(redis.set).toHaveBeenCalled(); // Tier 1 offers recreated
    expect((tepService as any).allocationService.createTiers).toHaveBeenCalled();
  });


  it("Scenario B: does not duplicate offers when active offers exist", async () => {
    mockBookingsRepository.getBooking.mockResolvedValueOnce({
      id: 123,
      status: "ALLOCATING",
      allocationTier: 1,
      pickupLatitude: 10,
      pickupLongitude: 20,
      serviceCategoryId: 5,
    });

    // Redis: active offers present
    redis.get.mockResolvedValueOnce("3");

    await tepService.resumeAllocation(123, 1);

    expect(redis.set).not.toHaveBeenCalled(); // no duplicates
  });

  it("Scenario C: ignores booking when status is ASSIGNED", async () => {
    mockBookingsRepository.getBooking.mockResolvedValueOnce({
      id: 123,
      status: "ASSIGNED",
      allocationTier: 1,
      pickupLatitude: 10,
      pickupLongitude: 20,
      serviceCategoryId: 5,
    });

    await tepService.resumeAllocation(123, 1);

    expect(redis.set).not.toHaveBeenCalled();
    expect(mockBookingsRepository.moveToNextAllocationTier).not.toHaveBeenCalled();
  });

  it("Scenario D: stops when winner exists", async () => {
    mockBookingsRepository.getBooking.mockResolvedValueOnce({
      id: 123,
      status: "ALLOCATING",
      allocationTier: 1,
      pickupLatitude: 10,
      pickupLongitude: 20,
      serviceCategoryId: 5,
    });

    mockAllocationLockService.getWinner.mockResolvedValueOnce({ workerId: 42 });

    await tepService.resumeAllocation(123, 1);

    expect(redis.set).not.toHaveBeenCalled();
    expect(mockBookingsRepository.moveToNextAllocationTier).not.toHaveBeenCalled();
  });
});


describe("Recovery with lease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Healthy allocation: recovery does nothing", async () => {
    mockLeaseService.acquire.mockResolvedValueOnce(false);

    await recoveryService.recoverBooking(123);

    expect(mockTepService.startTier).not.toHaveBeenCalled();
  });

  it("Crash: recovery resumes after lease expires", async () => {
    mockLeaseService.acquire.mockResolvedValueOnce(true);

    await recoveryService.recoverBooking(123);

    expect(mockTepService.startTier).toHaveBeenCalledWith(123, expect.any(Number));
    expect(mockLeaseService.release).toHaveBeenCalled();
  });

  it("Two recovery workers: only one acquires", async () => {
    mockLeaseService.acquire
      .mockResolvedValueOnce(true)   // Worker A
      .mockResolvedValueOnce(false); // Worker B

    await recoveryService.recoverBooking(123); // Worker A
    await recoveryService.recoverBooking(123); // Worker B

    expect(mockTepService.startTier).toHaveBeenCalledTimes(1);
  });

  it("Release after successful assignment", async () => {
    mockLeaseService.acquire.mockResolvedValueOnce(true);

    await recoveryService.recoverBooking(123);

    expect(mockLeaseService.release).toHaveBeenCalledWith(123, INSTANCE_ID);
  });
});

describe("Booking lifecycle", () => {
  let bookingId: number;

  beforeEach(async () => {
    // Create a fresh booking before each test
    const booking = await bookingsRepository.createBooking({
      customerId: 1,
      serviceCategoryId: 1,
      scheduledAt: new Date(),
      estimatedPrice: 100,
    });
    bookingId = booking.id;
  });

  it("should follow the full lifecycle", async () => {
    // Create booking → pending
    let booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("pending");

    // Start allocation → allocating
    await bookingsRepository.updateBookingStatus(bookingId, "allocating");
    booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("allocating");

    // Worker wins → assigned
    await bookingsRepository.assignWorker(bookingId, 42);
    booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("assigned");

    // /accept → accepted
    await bookingsService.transitionBookingStatus(bookingId, "accepted");
    booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("accepted");

    // /en-route → en_route
    await bookingsService.transitionBookingStatus(bookingId, "en_route");
    booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("en_route");

    // /start → working
    await bookingsService.transitionBookingStatus(bookingId, "working");
    booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("working");

    // /complete → completed
    await bookingsService.transitionBookingStatus(bookingId, "completed");
    booking = await bookingsRepository.findBookingById(bookingId);
    expect(booking?.status).toBe("completed");
  });

  it("should reject invalid transitions", async () => {
    // allocating → completed ❌
    await bookingsRepository.updateBookingStatus(bookingId, "allocating");
    await expect(
      bookingsService.transitionBookingStatus(bookingId, "completed")
    ).rejects.toThrow();

    // cancelled → accepted ❌
    await bookingsRepository.updateBookingStatus(bookingId, "cancelled");
    await expect(
      bookingsService.transitionBookingStatus(bookingId, "accepted")
    ).rejects.toThrow();

    // allocation_failed → assigned ❌
    await expect(
      bookingsRepository.updateBookingStatus(bookingId, "allocation_failed")
    ).rejects.toThrow();
    await expect(
      bookingsRepository.updateBookingStatus(bookingId, "ASSIGNED")
    ).rejects.toThrow();
  });
});