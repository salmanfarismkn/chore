export interface AllocationFence {
  bookingId: number;
  instanceId: string;
  generation: number;
  token: string;
}

export class AllocationFenceError extends Error {
  constructor(
    public readonly bookingId: number,
    public readonly generation: number,
    reason: string
  ) {
    super(`Allocation fence rejected: ${reason}`);
    this.name = "AllocationFenceError";
  }
}
