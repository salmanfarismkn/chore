import { redis } from "../../config/redis";

import { AllocationOfferService } from "./allocation-offer.service";
import { AllocationService } from "./allocation.service";

export class AllocationExpirationWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly allocationService: AllocationService,
    private readonly offerService: AllocationOfferService
  ) {}

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(
      () => {
        void this.processExpiredOffers();
      },
      1000
    );
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async processExpiredOffers() {
    // We'll implement the actual expiration lookup next.
  }
}