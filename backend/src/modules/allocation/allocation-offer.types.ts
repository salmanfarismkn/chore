export type AllocationOfferStatus =
  | "pending"
  | "accepted"
  | "expired"
  | "rejected";

export interface AllocationOffer {
  bookingId: number;
  workerId: number;
  tier: string;
  expiresAt: Date;
  status: AllocationOfferStatus;
}