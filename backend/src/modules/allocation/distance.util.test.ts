import { describe, it, expect } from "vitest";
import { calculateDistanceKm } from "./distance.util";

describe("calculateDistanceKm", () => {
  it("returns ~0 km for same location", () => {
    const distance = calculateDistanceKm(10.0, 76.0, 10.0, 76.0);
    expect(distance).toBeCloseTo(0, 5);
  });

  it("returns correct distance for known coordinates", () => {
    const distance = calculateDistanceKm(19.0760, 72.8777, 18.5204, 73.8567); // Mumbai → Pune
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(160);
  });

  it("is symmetric", () => {
    const distAB = calculateDistanceKm(19.0760, 72.8777, 18.5204, 73.8567);
    const distBA = calculateDistanceKm(18.5204, 73.8567, 19.0760, 72.8777);
    expect(distAB).toBeCloseTo(distBA, 5);
  });
});
