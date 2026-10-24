import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { buildApp } from "../../app";
import { db } from "../../db";
import { bookings, serviceCategories, users, workerProfiles, workerServices } from "../../db/schema";
import { WorkerPresenceService } from "../workers/worker-presence.service";

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

    const suffix = randomUUID();

    const [customer] = await db
      .insert(users)
      .values({
        phoneNumber: `+1555${suffix.replaceAll("-", "").slice(0, 15)}`,
        fullName: "Allocation Customer",
        role: "customer",
      })
      .returning({ id: users.id });

    const [worker] = await db
      .insert(users)
      .values({
        phoneNumber: `+1556${suffix.replaceAll("-", "").slice(0, 15)}`,
        fullName: "Allocation Worker",
        role: "worker",
      })
      .returning({ id: users.id });

    const [service] = await db
      .insert(serviceCategories)
      .values({
        name: `Allocation Service ${suffix}`,
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

    const presenceService = new WorkerPresenceService();
    await presenceService.setBusy(worker.id);
    const [updatedProfile] = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.userId, worker.id));
    expect(updatedProfile.status).toBe("busy");
    await presenceService.setAvailable(worker.id);

    await db.insert(workerServices).values({
      workerId: worker.id,
      serviceCategoryId: service.id,
      isActive: true,
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

  it("restricts offer creation and acceptance to authorized roles", async () => {
    const anonymousOffer = await app.inject({
      method: "POST",
      url: "/v1/allocation/bookings/1/offer",
      payload: {
        userId: workerId,
        tier: "tier-1",
        ttlSeconds: 60,
      },
    });
    expect(anonymousOffer.statusCode).toBe(401);

    const workerOffer = await app.inject({
      method: "POST",
      url: "/v1/allocation/bookings/1/offer",
      headers: { authorization: `Bearer ${workerToken}` },
      payload: {
        userId: workerId,
        tier: "tier-1",
        ttlSeconds: 60,
      },
    });
    expect(workerOffer.statusCode).toBe(403);

    const customerAccept = await app.inject({
      method: "POST",
      url: "/v1/allocation/bookings/1/accept",
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(customerAccept.statusCode).toBe(403);
  });

  it("rejects anonymous access to protected user and worker data", async () => {
    for (const url of [
      "/v1/users",
      "/v1/workers",
      "/v1/worker-services",
      "/v1/service-categories",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
    }
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

    expect(booking.customerId).toBe(customerId);
    expect(booking.serviceCategoryId).toBe(serviceCategoryId);

    const [allocatingBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(allocatingBooking.status).toBe("ALLOCATING");

    const acceptResponse = await app.inject({
      method: "POST",
      url: `/v1/allocation/bookings/${bookingId}/accept`,
      headers: {
        authorization: `Bearer ${workerToken}`,
      },
      payload: {
        workerId: workerId + 1000,
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

  it("marks a booking allocation as failed when no workers are eligible", async () => {
    const [serviceWithoutWorkers] = await db
      .insert(serviceCategories)
      .values({
        name: `No Worker Service ${randomUUID()}`,
        description: "No eligible worker regression fixture",
        basePrice: "50.00",
        estimatedDurationMinutes: 30,
      })
      .returning({ id: serviceCategories.id });

    const response = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": `no-worker-${randomUUID()}`,
      },
      payload: {
        customerId,
        serviceCategoryId: serviceWithoutWorkers.id,
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
      },
    });

    expect(response.statusCode).toBe(201);

    const [booking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, response.json().id));

    expect(booking.status).toBe("ALLOCATION_FAILED");
  });
});