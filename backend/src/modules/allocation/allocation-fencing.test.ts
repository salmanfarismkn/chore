import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/redis", () => ({
  redis: {
    set: vi.fn(),
    eval: vi.fn(),
  },
}));

import { redis } from "../../config/redis";
import { AllocationLeaseService } from "./allocation-lease.service";
import { AllocationAcceptanceService } from "./allocation-acceptance.service";

describe("allocation generation fencing", () => {
  const leaseService = new AllocationLeaseService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds every acquired lease to its generation", async () => {
    vi.mocked(redis.set).mockResolvedValue("OK");

    await leaseService.acquire(17, "instance-a", 1);
    await leaseService.acquire(17, "instance-a", 2);

    expect(vi.mocked(redis.set).mock.calls[0]?.[1]).toBe("instance-a:1");
    expect(vi.mocked(redis.set).mock.calls[1]?.[1]).toBe("instance-a:2");
  });

  it("does not renew after ownership changes to another generation", async () => {
    vi.mocked(redis.eval).mockResolvedValue(0);

    await expect(
      leaseService.renew(17, "instance-a", 1)
    ).resolves.toBe(false);

    expect(vi.mocked(redis.eval).mock.calls[0]?.[1]).toMatchObject({
      arguments: ["instance-a:1", "60"],
    });
  });

  it("cannot release a newer generation owned by another process", async () => {
    vi.mocked(redis.eval).mockResolvedValue(0);

    await expect(
      leaseService.release(17, "instance-a", 1)
    ).resolves.toBe(false);

    expect(vi.mocked(redis.eval).mock.calls[0]?.[1]).toMatchObject({
      arguments: ["instance-a:1"],
    });
  });

  it("updates a lease generation only from the expected owner token", async () => {
    vi.mocked(redis.eval).mockResolvedValue("OK");

    await expect(
      leaseService.updateGeneration(17, "instance-a", 1, 2)
    ).resolves.toBe(true);

    expect(vi.mocked(redis.eval).mock.calls[0]?.[1]).toMatchObject({
      arguments: ["instance-a:1", "instance-a:2", "60"],
    });
  });

  it("passes the expected generation into the atomic acceptance script", async () => {
    vi.mocked(redis.eval).mockResolvedValue(0);
    const acceptanceService = new AllocationAcceptanceService();

    await expect(
      acceptanceService.accept(17, 42, 3)
    ).resolves.toBe(false);

    const script = vi.mocked(redis.eval).mock.calls[0]?.[0];
    const options = vi.mocked(redis.eval).mock.calls[0]?.[1];
    expect(script).toContain("offerGeneration");
    expect(options).toMatchObject({
      arguments: ["42", "3", "42:3"],
    });
  });
});
