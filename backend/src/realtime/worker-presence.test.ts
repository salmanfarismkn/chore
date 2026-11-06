import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/redis", () => ({
  redis: {
    sAdd: vi.fn(),
    eval: vi.fn(),
    sMembers: vi.fn(),
    sCard: vi.fn(),
  },
}));

import { redis } from "../config/redis";
import {
  addWorkerConnection,
  removeWorkerConnection,
} from "./worker-presence";

describe("worker presence connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a connection to the worker set", async () => {
    await addWorkerConnection(7, "socket-a");

    expect(redis.sAdd).toHaveBeenCalledWith(
      "worker:7:connections",
      "socket-a"
    );
  });

  it("removes one connection and returns the atomic remaining count", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    await expect(
      removeWorkerConnection(7, "socket-a")
    ).resolves.toBe(1);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("SREM"),
      {
        keys: ["worker:7:connections"],
        arguments: ["socket-a"],
      }
    );
  });

  it("keeps a worker online while another connection remains", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    await expect(
      removeWorkerConnection(7, "socket-a")
    ).resolves.toBeGreaterThan(0);
  });
});
