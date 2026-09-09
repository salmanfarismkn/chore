import { vi } from "vitest";

// Mock Redis
export const redis = {
  set: vi.fn(),
  get: vi.fn(),
  clear: () => {
    redis.set.mockClear();
    redis.get.mockClear();
  },
};

// Mock BookingsRepository
export const mockBookingsRepository = {
  getBooking: vi.fn(),
  getAllocationState: vi.fn(),
  startAllocation: vi.fn(),
  moveToNextAllocationTier: vi.fn(),
  markAllocationFailed: vi.fn(),
};

// Mock AllocationLockService
export const mockAllocationLockService = {
  getWinner: vi.fn(),
};

// Mock TepService
export const tepService = {
  resumeAllocation: vi.fn(),
};
