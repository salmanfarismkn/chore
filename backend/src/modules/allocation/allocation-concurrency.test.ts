import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { AllocationLockService } from "./allocation-lock.service";
import { redis } from "../../config/redis";

describe("Allocation winner concurrency", () => {
  const lockService = new AllocationLockService();

  beforeAll(async () => {
    if (!redis.isOpen) {
      await redis.connect();
    }
  });

  beforeEach(async () => {
    await redis.flushDb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("allows exactly one worker to acquire the winner lock", async () => {
    const bookingId = Date.now();
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

  it("does not allow a second worker to overwrite the winner", async () => {
    const bookingId = Date.now();
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
    const bookingId = Date.now();
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
