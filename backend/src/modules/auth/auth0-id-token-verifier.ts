import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTPayload,
  type RemoteJWKSetOptions,
} from "jose";

const verifiedIdentityBrand: unique symbol = Symbol("verified-auth0-identity");

export interface VerifiedAuth0Identity {
  readonly [verifiedIdentityBrand]: true;
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly phoneNumber?: string;
  readonly phoneNumberVerified?: boolean;
}

export interface Auth0IdTokenVerifierConfig {
  issuer: string;
  clientIds: readonly string[];
}

export type Auth0IdTokenVerificationFailure =
  | "invalid_token"
  | "jwks_unavailable";

export class Auth0IdTokenVerificationError extends Error {
  constructor(public readonly failure: Auth0IdTokenVerificationFailure) {
    super(
      failure === "jwks_unavailable"
        ? "Auth0 signing keys are unavailable"
        : "Auth0 ID token is invalid",
    );
    this.name = "Auth0IdTokenVerificationError";
  }
}

export type JwksFetch = NonNullable<RemoteJWKSetOptions[typeof customFetch]>;

const CLOCK_TOLERANCE_SECONDS = 5;
const MAX_ID_TOKEN_AGE_SECONDS = 600;

const validateConfig = (config: Auth0IdTokenVerifierConfig) => {
  let issuer: URL;
  try {
    issuer = new URL(config.issuer);
  } catch {
    throw new Error("Auth0 issuer must be an absolute HTTPS URL");
  }

  if (
    issuer.protocol !== "https:" ||
    issuer.hostname.length === 0 ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.pathname !== "/" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    !config.issuer.endsWith("/") ||
    config.issuer.trim() !== config.issuer ||
    config.issuer.includes("*")
  ) {
    throw new Error("Auth0 issuer must be an exact HTTPS issuer URL");
  }

  if (
    config.clientIds.length === 0 ||
    config.clientIds.some(
      (clientId) =>
        clientId.length === 0 ||
        clientId.trim() !== clientId ||
        clientId.includes("*"),
    ) ||
    new Set(config.clientIds).size !== config.clientIds.length
  ) {
    throw new Error("Auth0 requires an explicit allowlist of client IDs");
  }

  return issuer;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.length > 0);

const validateClientAudience = (
  claims: JWTPayload,
  clientIds: readonly string[],
  expectedClientId?: string,
): string[] => {
  const audience =
    typeof claims.aud === "string"
      ? [claims.aud]
      : isStringArray(claims.aud)
        ? claims.aud
        : null;

  if (!audience || !audience.some((clientId) => clientIds.includes(clientId))) {
    throw new Auth0IdTokenVerificationError("invalid_token");
  }

  if (
    expectedClientId !== undefined &&
    (!clientIds.includes(expectedClientId) ||
      !audience.includes(expectedClientId))
  ) {
    throw new Auth0IdTokenVerificationError("invalid_token");
  }

  const authorizedParty = claims.azp;
  if (audience.length > 1) {
    if (
      typeof authorizedParty !== "string" ||
      !clientIds.includes(authorizedParty) ||
      !audience.includes(authorizedParty) ||
      (expectedClientId !== undefined && authorizedParty !== expectedClientId)
    ) {
      throw new Auth0IdTokenVerificationError("invalid_token");
    }
  } else if (
    authorizedParty !== undefined &&
    (typeof authorizedParty !== "string" ||
      !clientIds.includes(authorizedParty) ||
      authorizedParty !== audience[0] ||
      (expectedClientId !== undefined && authorizedParty !== expectedClientId))
  ) {
    throw new Auth0IdTokenVerificationError("invalid_token");
  }

  if (expectedClientId !== undefined && audience[0] !== expectedClientId) {
    throw new Auth0IdTokenVerificationError("invalid_token");
  }

  return audience;
};

const validateOptionalClaims = (claims: JWTPayload) => {
  if (
    (claims.email !== undefined && typeof claims.email !== "string") ||
    (claims.email_verified !== undefined &&
      typeof claims.email_verified !== "boolean") ||
    (claims.phone_number !== undefined &&
      typeof claims.phone_number !== "string") ||
    (claims.phone_number_verified !== undefined &&
      typeof claims.phone_number_verified !== "boolean")
  ) {
    throw new Auth0IdTokenVerificationError("invalid_token");
  }
};

const isJwksUnavailable = (error: unknown): boolean =>
  error instanceof JwksUnavailableError || error instanceof errors.JWKSTimeout;

class JwksUnavailableError extends Error {}

const guardJwksFetch =
  (fetcher: JwksFetch): JwksFetch =>
  async (url, options) => {
    let response: Response;
    try {
      response = await fetcher(url, options);
    } catch {
      throw new JwksUnavailableError();
    }

    if (response.status !== 200) {
      throw new JwksUnavailableError();
    }

    return response;
  };

export class Auth0IdTokenVerifier {
  private readonly clientIds: readonly string[];
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    config: Auth0IdTokenVerifierConfig,
    jwksFetch: JwksFetch = (url, options) => fetch(url, options),
    jwksOptions: Omit<RemoteJWKSetOptions, typeof customFetch> = {},
  ) {
    const issuerUrl = validateConfig(config);
    this.issuer = config.issuer;
    this.clientIds = [...config.clientIds];
    this.jwks = createRemoteJWKSet(
      new URL(".well-known/jwks.json", issuerUrl),
      {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
        ...jwksOptions,
        [customFetch]: guardJwksFetch(jwksFetch),
      },
    );
  }

  async verify(
    rawIdToken: string,
    expectedNonce: string,
    expectedClientId?: string,
  ): Promise<VerifiedAuth0Identity> {
    if (
      typeof rawIdToken !== "string" ||
      rawIdToken.length === 0 ||
      typeof expectedNonce !== "string" ||
      expectedNonce.length === 0
    ) {
      throw new Auth0IdTokenVerificationError("invalid_token");
    }

    try {
      const { payload, protectedHeader } = await jwtVerify(
        rawIdToken,
        this.jwks,
        {
          issuer: this.issuer,
          audience: [...this.clientIds],
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat", "nonce"],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          maxTokenAge: MAX_ID_TOKEN_AGE_SECONDS,
        },
      );

      if (
        protectedHeader.alg !== "RS256" ||
        typeof payload.sub !== "string" ||
        payload.sub.length === 0 ||
        typeof payload.iat !== "number" ||
        !Number.isFinite(payload.iat) ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        typeof payload.nonce !== "string" ||
        payload.nonce !== expectedNonce
      ) {
        throw new Auth0IdTokenVerificationError("invalid_token");
      }

      const audience = validateClientAudience(
        payload,
        this.clientIds,
        expectedClientId,
      );
      validateOptionalClaims(payload);

      return {
        [verifiedIdentityBrand]: true,
        issuer: this.issuer,
        subject: payload.sub,
        audience,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
        ...(typeof payload.email_verified === "boolean"
          ? { emailVerified: payload.email_verified }
          : {}),
        ...(typeof payload.phone_number === "string"
          ? { phoneNumber: payload.phone_number }
          : {}),
        ...(typeof payload.phone_number_verified === "boolean"
          ? { phoneNumberVerified: payload.phone_number_verified }
          : {}),
      };
    } catch (error) {
      if (error instanceof Auth0IdTokenVerificationError) {
        throw error;
      }
      if (isJwksUnavailable(error)) {
        throw new Auth0IdTokenVerificationError("jwks_unavailable");
      }
      throw new Auth0IdTokenVerificationError("invalid_token");
    }
  }
}
