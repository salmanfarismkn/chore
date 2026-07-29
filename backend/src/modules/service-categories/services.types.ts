export interface CreateServiceInput {
  name: string;
  description?: string;
  basePrice: number;
  estimatedDurationMinutes: number;
}

export interface ServiceResponse {
  id: number;
  name: string;
  description: string | null;
  basePrice: string;
  estimatedDurationMinutes: number;
  isActive: boolean;
  createdAt: Date;
}