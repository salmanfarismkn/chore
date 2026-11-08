import { AppError } from "../../shared/core/errors/app-error";

export type IdentityMappingConflictReason =
  | "identity_already_linked"
  | "user_already_has_identity";

export class IdentityMappingConflictError extends AppError {
  constructor(
    public readonly reason: IdentityMappingConflictReason,
    message: string,
  ) {
    super(message, 409);
  }
}

export class InvalidExternalIdentityError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class IdentityLinkAuthorizationError extends AppError {
  constructor(message: string) {
    super(message, 403);
  }
}
