import {
  IdentityLinkAuthorizationError,
  InvalidExternalIdentityError,
} from "./identity.errors";
import type { AuthUser } from "../auth/auth.types";
import {
  IdentityRepository,
  type ExternalIdentity,
} from "./identity.repository";

export interface IdentityLinkAuthorization {
  authenticatedUser: AuthUser;
  targetUserId: number;
}

export type IdentityResolution =
  | { status: "not_linked" }
  | { status: "linked"; userId: number };

const validateIdentity = (identity: ExternalIdentity) => {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(identity.issuer);
  } catch {
    throw new InvalidExternalIdentityError(
      "OIDC issuer must be an absolute URL",
    );
  }

  if (
    issuerUrl.protocol !== "https:" ||
    issuerUrl.username !== "" ||
    issuerUrl.password !== "" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    identity.issuer.trim() !== identity.issuer
  ) {
    throw new InvalidExternalIdentityError("OIDC issuer is invalid");
  }

  if (identity.subject.length === 0) {
    throw new InvalidExternalIdentityError("OIDC subject must not be empty");
  }
};

const assertAuthorizedTarget = (authorization: IdentityLinkAuthorization) => {
  const { authenticatedUser, targetUserId } = authorization;

  if (
    !Number.isSafeInteger(targetUserId) ||
    targetUserId < 1 ||
    !Number.isSafeInteger(authenticatedUser.userId) ||
    authenticatedUser.userId < 1 ||
    !["customer", "worker", "admin"].includes(authenticatedUser.role)
  ) {
    throw new IdentityLinkAuthorizationError(
      "Identity linking requires an authenticated local user",
    );
  }

  if (
    authenticatedUser.userId !== targetUserId &&
    authenticatedUser.role !== "admin"
  ) {
    throw new IdentityLinkAuthorizationError(
      "Only an administrator may link an identity to another user's account",
    );
  }

  return targetUserId;
};

export class IdentityMappingService {
  constructor(private readonly identityRepository: IdentityRepository) {}

  async resolveIdentity(
    identity: ExternalIdentity,
  ): Promise<IdentityResolution> {
    validateIdentity(identity);

    const mapping = await this.identityRepository.findByIssuerAndSubject(
      identity.issuer,
      identity.subject,
    );

    return mapping
      ? { status: "linked", userId: mapping.userId }
      : { status: "not_linked" };
  }

  async linkIdentityToUser(
    identity: ExternalIdentity,
    authorization: IdentityLinkAuthorization,
  ) {
    validateIdentity(identity);
    const targetUserId = assertAuthorizedTarget(authorization);

    return this.identityRepository.linkIdentityToUser(identity, targetUserId);
  }
}
