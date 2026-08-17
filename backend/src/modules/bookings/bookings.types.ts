import type { AllocationCandidate } from "../allocation/allocation.types";


export interface CreateBookingInput {
  customerId: number;    
  serviceCategoryId: number;  
  scheduledAt: Date;
  estimatedPrice: number;     
}

export interface BookingResponse {
  id: number;
  customerId: number;
  workerId: number | null;
  serviceCategoryId: number;
  status: 
    | "PENDING" 
    | "ALLOCATING" 
    | "ASSIGNED" 
    | "EN_ROUTE" 
    | "WORKING" 
    | "COMPLETED" 
    | "CANCELLED";
  allocationTier: number;
  estimatedPrice: number;
  finalPrice: number | null;
  otp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingWithCandidatesResponse extends BookingResponse {
  allocation: {
    candidates: AllocationCandidate[];
  };
}
