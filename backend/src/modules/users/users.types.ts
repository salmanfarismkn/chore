export type UserRole = "customer" | "worker";

export interface CreateUserInput {
  phoneNumber: string;
  fullName: string;
  role: UserRole;
}

export interface UserResponse {
  id: string;
  phoneNumber: string;
  fullName: string;
  role: UserRole;
}