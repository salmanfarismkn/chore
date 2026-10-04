import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";
import { AllocationAssignmentService } from "./allocation-assignment.service";
import { AllocationLockService } from "./allocation-lock.service";
import { redis } from "../../config/redis";

describe("Allocation winner concurrency", () => {
  const lockService = new AllocationLockService();
  const acceptanceService = new AllocationAcceptanceService(lockService);
  let bookingIds: number[] = [];
  let offerKeys: string[] = [];
  let nextBookingId = Date.now();

  const createBookingId = () => {
    const bookingId = ++nextBookingId;
    bookingIds.push(bookingId);
    return bookingId;
  };

  beforeAll(async () => {
    if (!redis.isOpen) {
      await redis.connect();
    }
  });

  beforeEach(() => {
    bookingIds = [];
    offerKeys = [];
  });

  afterEach(async () => {
    await Promise.all(
      [
        ...bookingIds.map((bookingId) => `booking:${bookingId}:allocation:winner`),
        ...offerKeys,
      ].map((key) => redis.del(key))
    );
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("allows exactly one worker to acquire the winner lock", async () => {
    const bookingId = createBookingId();
    const workerIds = [101, 102, 103, 104, 105];

    const results = await Promise.all(
      workerIds.map((workerId) =>
        lockService.acquireWinner(bookingId, workerId)
      )
    );

    const successful = results.filter(Boolean);
    expect(successful).toHaveLength(1);

    const winner = await lockService.getWinner(bookingId);
    expect(winner).not.toBeNull();
    expect(workerIds).toContain(winner);
  });

  it("allows only one simultaneous acceptance to claim a booking", async () => {
    const bookingId = createBookingId();
    const workerIds = [401, 402];

    for (const workerId of workerIds) {
      const offerKey = `booking:${bookingId}:offer:${workerId}`;
      offerKeys.push(offerKey);
      await redis.hSet(offerKey, {
        workerId: workerId.toString(),
        status: "pending",
        expiresAt: (Date.now() + 60_000).toString(),
      });
      await redis.expire(offerKey, 60);
    }

    const results = await Promise.all(
      workerIds.map((workerId) =>
        acceptanceService.accept(bookingId, workerId)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(workerIds).toContain(await lockService.getWinner(bookingId));
  });

  it("rejects expired and mismatched offers without a winner", async () => {
    const bookingId = createBookingId();
    const expiredWorkerId = 501;
    const expiredOfferKey = `booking:${bookingId}:offer:${expiredWorkerId}`;
    offerKeys.push(expiredOfferKey);
    await redis.hSet(expiredOfferKey, {
      workerId: expiredWorkerId.toString(),
      status: "pending",
      expiresAt: (Date.now() - 1_000).toString(),
    });

    expect(
      await acceptanceService.accept(bookingId, expiredWorkerId)
    ).toBe(false);
    expect((await redis.hGetAll(expiredOfferKey)).status).toBe("expired");

    const expectedWorkerId = 502;
    const presentedWorkerId = 503;
    const mismatchedOfferKey = `booking:${bookingId}:offer:${presentedWorkerId}`;
    offerKeys.push(mismatchedOfferKey);
    await redis.hSet(mismatchedOfferKey, {
      workerId: expectedWorkerId.toString(),
      status: "pending",
      expiresAt: (Date.now() + 60_000).toString(),
    });

    expect(
      await acceptanceService.accept(bookingId, presentedWorkerId)
    ).toBe(false);
    expect(await lockService.getWinner(bookingId)).toBeNull();
  });

  it("restores an offer and releases the winner when assignment fails", async () => {
    const bookingId = createBookingId();
    const workerId = 601;
    const offerKey = `booking:${bookingId}:offer:${workerId}`;
    offerKeys.push(offerKey);
    await redis.hSet(offerKey, {
      workerId: workerId.toString(),
      status: "pending",
      expiresAt: (Date.now() + 60_000).toString(),
    });
    await redis.expire(offerKey, 60);

    const assignmentService = new AllocationAssignmentService(
      {
        assignWorker: vi.fn().mockRejectedValue(new Error("database unavailable")),
      } as never,
      acceptanceService
    );

    await expect(
      assignmentService.acceptOffer(bookingId, workerId)
    ).rejects.toThrow("database unavailable");
    expect(await lockService.getWinner(bookingId)).toBeNull();
    expect((await redis.hGetAll(offerKey)).status).toBe("pending");
  });

  it("does not allow a second worker to overwrite the winner", async () => {
    const bookingId = createBookingId();
    const firstWorker = 201;
    const secondWorker = 202;

    const firstResult = await lockService.acquireWinner(bookingId, firstWorker);
    const secondResult = await lockService.acquireWinner(bookingId, secondWorker);

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(false);

    const winner = await lockService.getWinner(bookingId);
    expect(winner).toBe(firstWorker);
  });

  it("allows the winner to be released safely", async () => {
    const bookingId = createBookingId();
    const winner = 301;
    const otherWorker = 302;

    await lockService.acquireWinner(bookingId, winner);

    const wrongRelease = await lockService.releaseWinner(bookingId, otherWorker);
    expect(wrongRelease).toBe(false);
    expect(await lockService.getWinner(bookingId)).toBe(winner);

    const correctRelease = await lockService.releaseWinner(bookingId, winner);
    expect(correctRelease).toBe(true);
    expect(await lockService.getWinner(bookingId)).toBeNull();
  });
});
