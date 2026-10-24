import { redis } from "../../config/redis";

import { AllocationOfferService } from "./allocation-offer.service";
import { AllocationService } from "./allocation.service";
import { TepService } from "./tep.service";

export class AllocationExpirationWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly allocationService: AllocationService,
    private readonly offerService: AllocationOfferService,
    private readonly tepService: TepService
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

  async processExpiredOffers() {
    const expiredBookings = await this.offerService.expirePendingOffers();

    for (const bookingId of expiredBookings) {
      await this.tepService.advanceTier(bookingId);
    }
  }
}