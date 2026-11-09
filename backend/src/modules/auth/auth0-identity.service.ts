import { env } from "../../config/env";
import { IdentityMappingService } from "../auth-identities/identity-mapping.service";
import {
  Auth0IdTokenVerifier,
  type Auth0IdTokenVerifierConfig,
  type VerifiedAuth0Identity,
} from "./auth0-id-token-verifier";

export const auth0VerifierConfigFromEnvironment = (
  source: Pick<typeof env, "AUTH0_ISSUER" | "AUTH0_CLIENT_IDS">,
): Auth0IdTokenVerifierConfig => {
  const issuer = source.AUTH0_ISSUER;
  const rawClientIds = source.AUTH0_CLIENT_IDS?.split(",");
  const clientIds = rawClientIds?.map((clientId) => clientId.trim());

  if (
    !issuer ||
    !clientIds?.length ||
    clientIds.some((clientId) => !clientId)
  ) {
    throw new Error(
      "AUTH0_ISSUER and AUTH0_CLIENT_IDS are required to verify Auth0 ID tokens",
    );
  }

  return { issuer, clientIds };
};

let processAuth0Verifier: Auth0IdTokenVerifier | undefined;

export class Auth0IdentityService {
  constructor(
    private readonly verifier: Pick<Auth0IdTokenVerifier, "verify">,
    private readonly identityMappingService: IdentityMappingService,
  ) {}

  async resolveVerifiedIdentity(identity: VerifiedAuth0Identity) {
    const resolution = await this.identityMappingService.resolveIdentity({
      issuer: identity.issuer,
      subject: identity.subject,
    });

    return { identity, resolution };
  }

  async verifyAndResolveIdToken(
    rawIdToken: string,
    expectedNonce: string,
    expectedClientId?: string,
  ) {
    const identity = await this.verifier.verify(
      rawIdToken,
      expectedNonce,
      expectedClientId,
    );
    return this.resolveVerifiedIdentity(identity);
  }
}

export const createAuth0IdentityService = (
  identityMappingService: IdentityMappingService,
) => {
  processAuth0Verifier ??= new Auth0IdTokenVerifier(
    auth0VerifierConfigFromEnvironment(env),
  );

  return new Auth0IdentityService(processAuth0Verifier, identityMappingService);
};
