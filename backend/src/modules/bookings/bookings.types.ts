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
    | "pending"
    | "allocating"
    | "assigned"
    | "en_route"
    | "working"
    | "completed"
    | "cancelled";             
  estimatedPrice: number;
  finalPrice: number | null;
  otp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

