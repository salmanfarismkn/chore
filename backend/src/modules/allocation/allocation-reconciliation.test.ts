import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/redis", () => ({
  redis: {
    sMembers: vi.fn(),
    sRem: vi.fn(),
    scanIterator: vi.fn(),
    hGetAll: vi.fn(),
    eval: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("../../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([
            {
              status: "ALLOCATING",
              allocationGeneration: 3,
            },
          ]),
        }),
      }),
    }),
  },
}));

import { redis } from "../../config/redis";
import { AllocationOfferService } from "./allocation-offer.service";

describe("allocation reconciliation", () => {
  const service = new AllocationOfferService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.sRem).mockResolvedValue(1);
    vi.mocked(redis.scanIterator).mockReturnValue(
      (async function* () {})()
    );
  });

  it("removes terminal state only for the matching generation", async () => {
    vi.mocked(redis.sMembers).mockResolvedValue([
      "booking:7:offer:42",
    ]);
    vi.mocked(redis.hGetAll).mockResolvedValue({
      bookingId: "7",
      generation: "3",
      workerId: "42",
      status: "accepted",
    });
    vi.mocked(redis.eval).mockResolvedValue(1);

    await expect(
      service.reconcileBooking(7, 3, "ASSIGNED")
    ).resolves.toBe(true);

    expect(vi.mocked(redis.eval).mock.calls[0]?.[0]).toContain(
      "offerGeneration"
    );
    expect(vi.mocked(redis.eval).mock.calls[0]?.[1]).toMatchObject({
      arguments: ["3", "ASSIGNED", "42", "42:3"],
    });
  });

  it("does not touch a newer generation", async () => {
    vi.mocked(redis.sMembers).mockResolvedValue([
      "booking:7:offer:42",
    ]);
    vi.mocked(redis.hGetAll).mockResolvedValue({
      bookingId: "7",
      generation: "4",
      workerId: "42",
      status: "pending",
    });

    await expect(
      service.reconcileBooking(7, 3, "CANCELLED")
    ).resolves.toBe(true);

    expect(redis.eval).toHaveBeenCalled();
  });

  it("restores an accepted offer only when no lease remains", async () => {
    vi.mocked(redis.sMembers).mockResolvedValue([
      "booking:7:offer:42",
    ]);
    vi.mocked(redis.hGetAll).mockResolvedValue({
      bookingId: "7",
      generation: "3",
      workerId: "42",
      status: "accepted",
    });
    vi.mocked(redis.eval).mockResolvedValue(1);

    await expect(
      service.reconcileBooking(7, 3, "ALLOCATING")
    ).resolves.toBe(true);

    expect(vi.mocked(redis.eval)).toHaveBeenCalled();
  });

  it("is safe to retry when Redis reports no matching state", async () => {
    vi.mocked(redis.sMembers).mockResolvedValue([]);

    await expect(
      service.reconcileBooking(7, 3, "ASSIGNED")
    ).resolves.toBe(true);
  });

  it("revokes only pending offers owned by the disconnected worker", async () => {
    vi.mocked(redis.sMembers).mockResolvedValue([
      "booking:7:offer:42",
    ]);
    vi.mocked(redis.hGetAll).mockResolvedValue({
      bookingId: "7",
      workerId: "42",
      generation: "3",
      status: "pending",
    });
    vi.mocked(redis.eval).mockResolvedValue(1);

    await expect(
      service.revokeWorkerOffers(42)
    ).resolves.toBe(1);

    expect(vi.mocked(redis.eval).mock.calls[0]?.[1]).toMatchObject({
      arguments: ["42", "3"],
    });
  });
});
