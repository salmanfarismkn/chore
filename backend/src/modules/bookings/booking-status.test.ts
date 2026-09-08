import { BOOKING_TRANSITIONS, BookingStatus } from "./booking-status";
import { describe, it, expect } from "vitest";
function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}
describe("Valid booking transitions", () => {
  it("pending → allocating", () => {
    expect(canTransition("PENDING", "ALLOCATING")).toBe(true);
  });

  it("allocating → assigned", () => {
    expect(canTransition("ALLOCATING", "ASSIGNED")).toBe(true);
  });

  it("assigned → accepted", () => {
    expect(canTransition("ASSIGNED", "ACCEPTED")).toBe(true);
  });

  it("accepted → en_route", () => {
    expect(canTransition("ACCEPTED", "EN_ROUTE")).toBe(true);
  });

  it("en_route → working", () => {
    expect(canTransition("EN_ROUTE", "WORKING")).toBe(true);
  });

  it("working → completed", () => {
    expect(canTransition("WORKING", "COMPLETED")).toBe(true);
  });
});
describe("Invalid booking transitions", () => {
  it("completed → working", () => {
    expect(canTransition("COMPLETED", "WORKING")).toBe(false);
  });

  it("cancelled → accepted", () => {
    expect(canTransition("CANCELLED", "ACCEPTED")).toBe(false);
  });

  it("pending → completed", () => {
    expect(canTransition("PENDING", "COMPLETED")).toBe(false);
  });

  it("allocation_failed → assigned", () => {
    expect(canTransition("ALLOCATION_FAILED", "ASSIGNED")).toBe(false);
  });
});
describe("Race condition on assignment", () => {
  it("only one worker can succeed", async () => {
    // Mock repository with current status = ALLOCATING
    const repo = {
      status: "ALLOCATING" as BookingStatus,
      workerId: undefined as number | undefined,
      async assign(workerId: number) {
        if (this.status !== "ALLOCATING") {
          return false;
        }
        this.status = "ASSIGNED";
        this.workerId = workerId;
        return true;
      },
    };

    const resultA = await repo.assign(1); // Worker A
    const resultB = await repo.assign(2); // Worker B

    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
    expect(repo.workerId).toBe(1); // Worker A wins
  });
});

describe("Valid cancellation transitions", () => {
  it("pending → cancelled", () => {
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
  });

  it("allocating → cancelled", () => {
    expect(canTransition("ALLOCATING", "CANCELLED")).toBe(true);
  });

  it("assigned → cancelled", () => {
    expect(canTransition("ASSIGNED", "CANCELLED")).toBe(true);
  });

  it("accepted → cancelled", () => {
    expect(canTransition("ACCEPTED", "CANCELLED")).toBe(true);
  });

  it("en_route → cancelled", () => {
    expect(canTransition("EN_ROUTE", "CANCELLED")).toBe(true);
  });

  it("working → cancelled", () => {
    expect(canTransition("WORKING", "CANCELLED")).toBe(true);
  });
});
describe("Invalid cancellation transitions", () => {
  it("completed → cancelled", () => {
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
  });

  it("cancelled → cancelled", () => {
    expect(canTransition("CANCELLED", "CANCELLED")).toBe(false);
  });

  it("allocation_failed → cancelled", () => {
    expect(canTransition("ALLOCATION_FAILED", "CANCELLED")).toBe(false);
  });
});
describe("Tier progression stops after cancellation", () => {
  it("does not advance tiers when booking is cancelled", async () => {
    const booking = { status: "CANCELLED" as BookingStatus };
    const handler = async () => {
      if (booking.status !== "ALLOCATING") {
        return "stopped";
      }
      return "advanced";
    };

    expect(await handler()).toBe("stopped");
  });
});
describe("Customer cancels after assignment", () => {
  it("assigned → cancelled", () => {
    const booking = { status: "ASSIGNED" as BookingStatus };
    const cancelled = canTransition(booking.status, "CANCELLED");
    expect(cancelled).toBe(true);
  });
});
