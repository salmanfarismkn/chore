// src/modules/allocation/acceptance.service.ts
import { AllocationLockService } from "./allocation-lock.service";

export class AcceptanceService {
  private lockService = new AllocationLockService();

  async accept(bookingId: number, workerId: number): Promise<boolean> {
    // Try to acquire lock for this booking
    const acquired = await this.lockService.acquire(bookingId, workerId, 30);

    if (!acquired) {
      return false; // someone else already accepted
    }

    // You could also persist acceptance in DB here
    return true;
  }
}
