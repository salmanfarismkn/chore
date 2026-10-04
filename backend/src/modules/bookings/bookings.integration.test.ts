import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../app";
import { db } from "../../db";
import { bookings, serviceCategories, users } from "../../db/schema";

describe("Bookings integration", () => {
  const app = buildApp();

  let token: string;
  let customerId: number;
  let serviceCategoryId: number;

  beforeAll(async () => {
    await app.ready();

    const suffix = Date.now();

    const [customer] = await db
      .insert(users)
      .values({
        phoneNumber: `+1555${suffix}`,
        fullName: `Customer ${suffix}`,
        role: "customer",
      })
      .returning({ id: users.id });

    const [service] = await db
      .insert(serviceCategories)
      .values({
        name: `Test Service ${suffix}`,
        description: "Integration test service",
        basePrice: "100.00",
        estimatedDurationMinutes: 60,
      })
      .returning({ id: serviceCategories.id });

    customerId = customer.id;
    serviceCategoryId = service.id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/test-token",
      payload: {
        userId: customerId,
        role: "customer",
      },
    });

    expect(response.statusCode).toBe(200);

    token = response.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a booking with an idempotency key", async () => {
    const idempotencyKey = `integration-test-${Date.now()}`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        customerId,
        serviceCategoryId,
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
      },
    });

    expect(response.statusCode).toBe(201);

    const booking = response.json();

    expect(booking).toHaveProperty("id");
    expect(booking.customerId).toBe(customerId);
    expect(booking.serviceCategoryId).toBe(serviceCategoryId);
  });

  it("returns the same booking for a repeated idempotency key", async () => {
    const idempotencyKey = `integration-repeat-${Date.now()}`;

    const payload = {
      customerId,
      serviceCategoryId,
      pickupLatitude: 23.2599,
      pickupLongitude: 77.4126,
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      payload,
    });

    expect(firstResponse.statusCode).toBe(201);

    const firstBooking = firstResponse.json();

    const secondResponse = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      payload,
    });

    expect(secondResponse.statusCode).toBe(200);

    const secondBooking = secondResponse.json();

    expect(secondBooking.id).toBe(firstBooking.id);
  });

  it("creates only one booking for concurrent duplicate requests", async () => {
    const idempotencyKey = `integration-concurrent-${Date.now()}`;
    const payload = {
      customerId,
      serviceCategoryId,
      pickupLatitude: 23.2599,
      pickupLongitude: 77.4126,
    };
    const request = () => app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      payload,
    });

    const [firstResponse, secondResponse] = await Promise.all([
      request(),
      request(),
    ]);

    expect([200, 201]).toContain(firstResponse.statusCode);
    expect([200, 201]).toContain(secondResponse.statusCode);
    expect(firstResponse.json().id).toBe(secondResponse.json().id);

    const [storedBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, firstResponse.json().id));
    expect(storedBooking).toBeDefined();
  });

  it("prevents creating bookings for another customer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": `integration-owner-${Date.now()}`,
      },
      payload: {
        customerId: customerId + 1000,
        serviceCategoryId,
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("restricts booking lists to the owning customer or an admin", async () => {
    const otherCustomerResponse = await app.inject({
      method: "GET",
      url: `/v1/bookings/customer/${customerId + 1000}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(otherCustomerResponse.statusCode).toBe(403);

    const allBookingsResponse = await app.inject({
      method: "GET",
      url: "/v1/bookings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allBookingsResponse.statusCode).toBe(403);
  });

  it("rejects booking creation without authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        "idempotency-key": `integration-auth-${Date.now()}`,
      },
      payload: {
        customerId,
        serviceCategoryId,
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects booking creation without an idempotency key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        customerId,
        serviceCategoryId,
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});