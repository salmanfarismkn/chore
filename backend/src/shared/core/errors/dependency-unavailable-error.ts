import { AppError } from "./app-error";

export type DependencyName = "database" | "redis" | "realtime";

export class DependencyUnavailableError extends AppError {
  constructor(public readonly dependency: DependencyName) {
    super("Service temporarily unavailable", 503);
  }
}
