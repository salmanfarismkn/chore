

export function canTransition(
  current: BookingStatus,
  next: BookingStatus
): boolean {
  return BOOKING_TRANSITIONS[current]?.includes(next) ?? false;
}


export type BookingStatus =
  | "PENDING"
  | "ALLOCATING"
  | "ASSIGNED"
  | "ACCEPTED"
  | "EN_ROUTE"
  | "WORKING"
  | "COMPLETED"
  | "CANCELLED"
  | "ALLOCATION_FAILED";

export const BOOKING_TRANSITIONS: Record<
  BookingStatus,
  BookingStatus[]
> = {
  PENDING: ["ALLOCATING", "CANCELLED"],

  ALLOCATING: [
    "ASSIGNED",
    "ALLOCATION_FAILED",
    "CANCELLED",
  ],

  ASSIGNED: [
    "ACCEPTED",
    "CANCELLED",
  ],

  ACCEPTED: [
    "EN_ROUTE",
    "CANCELLED",
  ],

  EN_ROUTE: [
    "WORKING",
    "CANCELLED",
  ],

  WORKING: [
    "COMPLETED",
    "CANCELLED",
  ],

  COMPLETED: [],

  CANCELLED: [],

  ALLOCATION_FAILED: [],
};
