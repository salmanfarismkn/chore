import { describe, expect, it, vi } from "vitest";

const emit = vi.fn();

vi.mock("./socket", () => ({
  getSocketIO: () => ({
    to: () => ({ emit }),
  }),
}));

import { emitWorkerOffer } from "./allocation-events";

describe("worker offer notifications", () => {
  it("includes booking, offer, and generation identifiers", () => {
    emitWorkerOffer({
      bookingId: 7,
      offerId: "booking:7:offer:42",
      workerId: 42,
      tier: "tier_1",
      expiresAt: 123,
      generation: 3,
    });

    expect(emit).toHaveBeenCalledWith(
      "booking:offer",
      expect.objectContaining({
        bookingId: 7,
        offerId: "booking:7:offer:42",
        generation: 3,
      })
    );
  });
});
