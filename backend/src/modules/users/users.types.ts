export type UserRole = "customer" | "worker" | "admin";


export interface CreateUserInput {
  phoneNumber: string;
  fullName: string;
  role: UserRole;
}

export interface UserResponse {
  id: number;
  phoneNumber: string;
  fullName: string;
  role: UserRole;
}