import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { buildApp } from "../../app";
import { db } from "../../db";
import { bookings, serviceCategories, users, workerProfiles } from "../../db/schema";

describe("Allocation integration", () => {
  const app = buildApp();

  let customerToken: string;
  let workerToken: string;
  let bookingId: number;
  let customerId: number;
  let workerId: number;
  let serviceCategoryId: number;

  beforeAll(async () => {
    await app.ready();

    const [customer] = await db
      .insert(users)
      .values({
        phoneNumber: `+1555${Date.now()}`,
        fullName: "Allocation Customer",
        role: "customer",
      })
      .returning({ id: users.id });

    const [worker] = await db
      .insert(users)
      .values({
        phoneNumber: `+1556${Date.now()}`,
        fullName: "Allocation Worker",
        role: "worker",
      })
      .returning({ id: users.id });

    const [service] = await db
      .insert(serviceCategories)
      .values({
        name: `Allocation Service ${Date.now()}`,
        description: "Seeded for allocation integration",
        basePrice: "120.00",
        estimatedDurationMinutes: 45,
      })
      .returning({ id: serviceCategories.id });

    await db
      .insert(workerProfiles)
      .values({
        userId: worker.id,
        status: "available",
        averageRating: 4.9,
        completedJobs: 12,
        latitude: 23.2599,
        longitude: 77.4126,
      });

    customerId = customer.id;
    workerId = worker.id;
    serviceCategoryId = service.id;

    const customerTokenResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/test-token",
      payload: {
        userId: customerId,
        role: "customer",
      },
    });

    expect(customerTokenResponse.statusCode).toBe(200);
    customerToken = customerTokenResponse.json().token;

    const workerTokenResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/test-token",
      payload: {
        userId: workerId,
        role: "worker",
      },
    });

    expect(workerTokenResponse.statusCode).toBe(200);
    workerToken = workerTokenResponse.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("allocates a booking and assigns the accepted worker", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": `allocation-${Date.now()}`,
      },
      payload: {
        customerId,
        serviceCategoryId,
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
      },
    });

    expect(createResponse.statusCode).toBe(201);

    const booking = createResponse.json();
    bookingId = booking.id;

    await db
      .update(bookings)
      .set({ status: "ALLOCATING" })
      .where(eq(bookings.id, bookingId));

    expect(booking.customerId).toBe(customerId);
    expect(booking.serviceCategoryId).toBe(serviceCategoryId);

    const offerResponse = await app.inject({
      method: "POST",
      url: `/v1/allocation/bookings/${bookingId}/offer`,
      headers: {
        authorization: `Bearer ${workerToken}`,
      },
      payload: {
        userId: workerId,
        tier: "tier-1",
        ttlSeconds: 60,
      },
    });

    expect(offerResponse.statusCode).toBe(201);

    const acceptResponse = await app.inject({
      method: "POST",
      url: `/v1/allocation/bookings/${bookingId}/accept`,
      headers: {
        authorization: `Bearer ${workerToken}`,
      },
      payload: {
        userId: workerId,
      },
    });

    expect(acceptResponse.statusCode).toBe(200);

    const assignedBooking = acceptResponse.json();

    expect(assignedBooking.id).toBe(bookingId);
    expect(assignedBooking.workerId).toBe(workerId);
    expect(assignedBooking.status).toBe("ASSIGNED");
  });

  it("persists the assignment in PostgreSQL", async () => {
    expect(bookingId).toBeDefined();

    const [booking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId));

    expect(booking).toBeDefined();
    expect(booking.workerId).toBe(workerId);
    expect(booking.status).toBe("ASSIGNED");
  });
});