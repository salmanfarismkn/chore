import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  io as createSocketClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app";
import { redis } from "../../config/redis";
import { db } from "../../db";
import {
  bookings,
  serviceCategories,
  users,
  workerProfiles,
  workerServices,
} from "../../db/schema";
import { AllocationAcceptanceService } from "../allocation/allocation-acceptance.service";
import { AllocationOfferService } from "../allocation/allocation-offer.service";
import { AllocationRepository } from "../allocation/allocation.repository";

describe("worker approval lifecycle integration", () => {
  const app = buildApp();
  const fixtureUserIds: number[] = [];
  let adminId: number;
  let workerId: number;
  let workerProfileId: number;
  let customerId: number;
  let serviceCategoryId: number;
  let offerBookingId: number;
  let assignedBookingId: number;
  let activeBookingId: number;
  let adminToken: string;
  let workerToken: string;
  let baseUrl: string;
  let workerSocket: ClientSocket | undefined;

  beforeAll(async () => {
    await app.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start worker approval test server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 15);
    const [admin] = await db
      .insert(users)
      .values({
        phoneNumber: `+1557${suffix}`,
        fullName: "Worker approval administrator",
        role: "admin",
      })
      .returning({ id: users.id });
    const [worker] = await db
      .insert(users)
      .values({
        phoneNumber: `+1558${suffix}`,
        fullName: "Pending approval worker",
        role: "worker",
      })
      .returning({ id: users.id });
    const [customer] = await db
      .insert(users)
      .values({
        phoneNumber: `+1559${suffix}`,
        fullName: "Worker approval customer",
        role: "customer",
      })
      .returning({ id: users.id });
    fixtureUserIds.push(admin.id, worker.id, customer.id);
    adminId = admin.id;
    workerId = worker.id;
    customerId = customer.id;

    const [profile] = await db
      .insert(workerProfiles)
      .values({
        userId: workerId,
        status: "available",
        latitude: 23.2599,
        longitude: 77.4126,
      })
      .returning();
    workerProfileId = profile.id;

    const [service] = await db
      .insert(serviceCategories)
      .values({
        name: `Worker approval service ${suffix}`,
        description: "Worker approval integration fixture",
        basePrice: "70.00",
        estimatedDurationMinutes: 30,
      })
      .returning({ id: serviceCategories.id });
    serviceCategoryId = service.id;
    await db.insert(workerServices).values({
      workerId,
      serviceCategoryId,
      isActive: true,
    });

    const [offerBooking] = await db
      .insert(bookings)
      .values({
        customerId,
        serviceCategoryId,
        status: "ALLOCATING",
        allocationGeneration: 1,
        scheduledAt: new Date(),
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
        estimatedPrice: "70.00",
      })
      .returning({ id: bookings.id });
    offerBookingId = offerBooking.id;

    const [assignedBooking] = await db
      .insert(bookings)
      .values({
        customerId,
        workerId,
        serviceCategoryId,
        status: "ACCEPTED",
        scheduledAt: new Date(),
        estimatedPrice: "70.00",
      })
      .returning({ id: bookings.id });
    assignedBookingId = assignedBooking.id;

    const [activeBooking] = await db
      .insert(bookings)
      .values({
        customerId,
        workerId,
        serviceCategoryId,
        status: "WORKING",
        scheduledAt: new Date(),
        estimatedPrice: "70.00",
      })
      .returning({ id: bookings.id });
    activeBookingId = activeBooking.id;

    const [adminSession, workerSession] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/test-token",
        payload: { userId: adminId, role: "admin" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/test-token",
        payload: { userId: workerId, role: "worker" },
      }),
    ]);
    expect(adminSession.statusCode).toBe(200);
    expect(workerSession.statusCode).toBe(200);
    adminToken = adminSession.json().token;
    workerToken = workerSession.json().token;
  });

  afterAll(async () => {
    workerSocket?.close();
    if (offerBookingId) {
      const offerKey = `booking:${offerBookingId}:offer:${workerId}`;
      await redis.sRem("allocation:offers:pending", offerKey);
      await redis.sRem(`worker:${workerId}:offers:pending`, offerKey);
      await redis.sRem(`booking:${offerBookingId}:allocation:offers`, offerKey);
      await redis.del([
        offerKey,
        `booking:${offerBookingId}:allocation:winner`,
        `booking:${offerBookingId}:allocation:lease`,
      ]);
    }
    if (fixtureUserIds.length > 0) {
      await db
        .delete(workerServices)
        .where(
          and(
            eq(workerServices.workerId, workerId),
            eq(workerServices.serviceCategoryId, serviceCategoryId),
          ),
        );
      await db
        .delete(bookings)
        .where(
          inArray(bookings.id, [
            offerBookingId,
            assignedBookingId,
            activeBookingId,
          ]),
        );
      await db
        .delete(workerProfiles)
        .where(inArray(workerProfiles.userId, fixtureUserIds));
      await db
        .delete(serviceCategories)
        .where(eq(serviceCategories.id, serviceCategoryId));
      await db.delete(users).where(inArray(users.id, fixtureUserIds));
    }
    await app.close();
  });

  it("defaults to pending, excludes ineligible workers, and revokes offers without altering active work", async () => {
    const allocationRepository = new AllocationRepository();
    const offerService = new AllocationOfferService();
    const acceptanceService = new AllocationAcceptanceService();

    const pendingSocket = createSocketClient(baseUrl, {
      auth: { token: workerToken },
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      pendingSocket.once("connect", () => {
        pendingSocket.close();
        reject(new Error("Pending worker connected to Socket.IO"));
      });
      pendingSocket.once("connect_error", () => {
        pendingSocket.close();
        resolve();
      });
    });

    const [pendingProfile] = await db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, workerProfileId));
    expect(pendingProfile.approvalStatus).toBe("pending");
    expect(pendingProfile.status).toBe("available");
    expect(
      await allocationRepository.findCandidates(serviceCategoryId),
    ).toEqual([]);
    await expect(
      offerService.createOffer(offerBookingId, workerId, "tier-1", 300),
    ).resolves.toMatchObject({ status: "unavailable" });

    const approved = await app.inject({
      method: "POST",
      url: `/v1/workers/${workerProfileId}/approval`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { approvalStatus: "approved" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      approvalStatus: "approved",
      approvalDecidedBy: adminId,
    });
    expect(approved.json().approvalDecidedAt).toBeTruthy();
    expect(
      await allocationRepository.findCandidates(serviceCategoryId),
    ).toHaveLength(1);
    const repeatedApproval = await app.inject({
      method: "POST",
      url: `/v1/workers/${workerProfileId}/approval`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { approvalStatus: "approved" },
    });
    expect(repeatedApproval.statusCode).toBe(200);
    expect(repeatedApproval.json().approvalDecidedAt).toBe(
      approved.json().approvalDecidedAt,
    );
    workerSocket = createSocketClient(baseUrl, {
      auth: { token: workerToken },
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      workerSocket?.once("connect", () => resolve());
      workerSocket?.once("connect_error", reject);
    });

    await expect(
      offerService.createOffer(offerBookingId, workerId, "tier-1", 300),
    ).resolves.toMatchObject({ status: "pending" });
    const outstanding = await offerService.getOffer(offerBookingId, workerId);
    expect(outstanding?.status).toBe("pending");

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/workers/${workerProfileId}/approval`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { approvalStatus: "rejected" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().approvalStatus).toBe("rejected");
    const socketDisconnected = new Promise<void>((resolve) => {
      workerSocket?.once("disconnect", () => resolve());
    });
    workerSocket.emit("worker:availability", "available");
    await expect(socketDisconnected).resolves.toBeUndefined();
    expect(await offerService.getOffer(offerBookingId, workerId)).toMatchObject(
      {
        status: "rejected",
      },
    );
    await expect(
      acceptanceService.accept(offerBookingId, workerId, 1),
    ).resolves.toBe(false);
    expect(
      await allocationRepository.findCandidates(serviceCategoryId),
    ).toEqual([]);
    await expect(
      offerService.createOffer(offerBookingId, workerId, "tier-2", 300),
    ).resolves.toMatchObject({ status: "unavailable" });

    const workerAccept = await app.inject({
      method: "POST",
      url: `/v1/allocation/bookings/${offerBookingId}/accept`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(workerAccept.statusCode).toBe(403);
    const workerStart = await app.inject({
      method: "POST",
      url: `/v1/bookings/${assignedBookingId}/start`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(workerStart.statusCode).toBe(403);

    const [allocatingBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, offerBookingId));
    const [stillAcceptedBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, assignedBookingId));
    const [activeBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, activeBookingId));
    expect(allocatingBooking.status).toBe("ALLOCATING");
    expect(allocatingBooking.workerId).toBeNull();
    expect(stillAcceptedBooking.status).toBe("ACCEPTED");
    expect(activeBooking.status).toBe("WORKING");
    expect(activeBooking.workerId).toBe(workerId);

    const reapproval = await app.inject({
      method: "POST",
      url: `/v1/workers/${workerProfileId}/approval`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { approvalStatus: "approved" },
    });
    expect(reapproval.statusCode).toBe(409);
  });
});
