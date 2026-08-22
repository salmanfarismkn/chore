export interface AuthUser {
  userId: number;
  role: "customer" | "worker" | "admin";
}