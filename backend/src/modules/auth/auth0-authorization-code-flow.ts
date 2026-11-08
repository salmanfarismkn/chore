import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "../../config/env";
import type { IdentityResolution } from "../auth-identities/identity-mapping.service";
import { Auth0IdTokenVerificationError } from "./auth0-id-token-verifier";
import { AppSessionError, SessionService } from "../sessions/session.service";
import {
  OidcTransactionStoreError,
  type Auth0LoginTransaction,
  type Auth0LoginTransactionStore,
} from "./auth0-login-transaction";

export type Auth0ClientType = "web" | "native";

export interface Auth0ClientRegistration {
  clientId: string;
  redirectUris: readonly string[];
}

export interface Auth0AuthorizationCodeFlowConfig {
  issuer: string;
  clients: Record<Auth0ClientType, Auth0ClientRegistration>;
  transactionTtlSeconds?: number;
}

export type Auth0LoginFlowFailure =
  | "invalid_request"
  | "invalid_transaction"
  | "provider_failure"
  | "not_linked"
  | "account_unavailable"
  | "temporarily_unavailable";

export class Auth0LoginFlowError extends Error {
  constructor(public readonly failure: Auth0LoginFlowFailure) {
    super("Auth0 authorization failed");
    this.name = "Auth0LoginFlowError";
  }
}

export interface Auth0LoginStartResult {
  authorizationUrl: string;
  expiresAt: string;
  loginContextCookie?: string;
  nativeContextBinding?: string;
}

export interface Auth0LoginCallback {
  state: string;
  code?: string;
  error?: string;
  contextBinding?: string;
}

export interface Auth0LoginCompletion {
  status: "authenticated";
  clientType: Auth0ClientType;
  credential: string;
  csrfToken: string | null;
  expiresAt: Date;
}

export interface AppSessionIssuer {
  create(
    userId: number,
    clientType: Auth0ClientType,
  ): Promise<{
    credential: string;
    csrfToken: string | null;
    expiresAt: Date;
  }>;
}

export interface Auth0VerifiedIdentityResolver {
  verifyAndResolveIdToken(
    rawIdToken: string,
    expectedNonce: string,
    expectedClientId?: string,
  ): Promise<{ resolution: IdentityResolution }>;
}

export interface LocalAccountStatusRepository {
  findUserById(id: number): Promise<{ id: number; isActive: boolean } | null>;
}

type Fetcher = typeof fetch;

const DEFAULT_TRANSACTION_TTL_SECONDS = 600;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const AUTH0_REQUEST_TIMEOUT_MS = 5_000;

const randomSecret = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const constantTimeHexEqual = (left: string, right: string) =>
  /^[\da-f]{64}$/i.test(left) &&
  /^[\da-f]{64}$/i.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const validateRedirectUri = (
  clientType: Auth0ClientType,
  redirectUri: string,
) => {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("Auth0 redirect URI must be absolute");
  }

  const isWebRedirect = url.protocol === "https:";
  const isNativeRedirect =
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    !["data:", "file:", "javascript:"].includes(url.protocol) &&
    /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol);

  if (
    (clientType === "web" && !isWebRedirect) ||
    (clientType === "native" && !isWebRedirect && !isNativeRedirect) ||
    url.href !== redirectUri ||
    (isWebRedirect && url.hostname.length === 0) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    redirectUri.trim() !== redirectUri ||
    redirectUri.includes("*")
  ) {
    throw new Error("Auth0 redirect URI is invalid");
  }
};

const validateConfig = (config: Auth0AuthorizationCodeFlowConfig) => {
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

  const clientIds = [
    config.clients.web.clientId,
    config.clients.native.clientId,
  ];
  if (
    clientIds.some(
      (clientId) =>
        clientId.length === 0 ||
        clientId.trim() !== clientId ||
        clientId.includes("*"),
    ) ||
    new Set(clientIds).size !== clientIds.length
  ) {
    throw new Error("Web and native Auth0 client IDs must be distinct");
  }

  for (const clientType of ["web", "native"] as const) {
    const { redirectUris } = config.clients[clientType];
    if (
      redirectUris.length === 0 ||
      new Set(redirectUris).size !== redirectUris.length
    ) {
      throw new Error(`Auth0 ${clientType} redirect URI allowlist is invalid`);
    }
    for (const redirectUri of redirectUris) {
      validateRedirectUri(clientType, redirectUri);
    }
  }

  const transactionTtlSeconds =
    config.transactionTtlSeconds ?? DEFAULT_TRANSACTION_TTL_SECONDS;
  if (
    !Number.isSafeInteger(transactionTtlSeconds) ||
    transactionTtlSeconds < 60 ||
    transactionTtlSeconds > 900
  ) {
    throw new Error(
      "OIDC transaction lifetime must be between 60 and 900 seconds",
    );
  }

  return {
    issuer: config.issuer,
    clients: config.clients,
    transactionTtlSeconds,
  };
};

const parseCsv = (value: string | undefined, name: string): string[] => {
  const values = value?.split(",").map((item) => item.trim());
  if (
    !values?.length ||
    values.some((item) => item.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${name} must be a non-empty comma-separated allowlist`);
  }
  return values;
};

export const auth0AuthorizationCodeFlowConfigFromEnvironment = (
  source: Pick<
    typeof env,
    | "AUTH0_ISSUER"
    | "AUTH0_CLIENT_IDS"
    | "AUTH0_WEB_CLIENT_ID"
    | "AUTH0_NATIVE_CLIENT_ID"
    | "AUTH0_WEB_REDIRECT_URIS"
    | "AUTH0_NATIVE_REDIRECT_URIS"
  >,
): Auth0AuthorizationCodeFlowConfig => {
  const { AUTH0_ISSUER: issuer } = source;
  const webClientId = source.AUTH0_WEB_CLIENT_ID;
  const nativeClientId = source.AUTH0_NATIVE_CLIENT_ID;
  if (!issuer || !webClientId || !nativeClientId) {
    throw new Error(
      "Auth0 issuer and separate web/native client IDs are required",
    );
  }

  const configuredClientIds = parseCsv(
    source.AUTH0_CLIENT_IDS,
    "AUTH0_CLIENT_IDS",
  );
  const expectedClientIds = [webClientId, nativeClientId];
  if (
    configuredClientIds.length !== expectedClientIds.length ||
    expectedClientIds.some(
      (clientId) => !configuredClientIds.includes(clientId),
    )
  ) {
    throw new Error(
      "AUTH0_CLIENT_IDS must exactly match the web and native Auth0 client IDs",
    );
  }

  return validateConfig({
    issuer,
    clients: {
      web: {
        clientId: webClientId,
        redirectUris: parseCsv(
          source.AUTH0_WEB_REDIRECT_URIS,
          "AUTH0_WEB_REDIRECT_URIS",
        ),
      },
      native: {
        clientId: nativeClientId,
        redirectUris: parseCsv(
          source.AUTH0_NATIVE_REDIRECT_URIS,
          "AUTH0_NATIVE_REDIRECT_URIS",
        ),
      },
    },
  });
};

export class Auth0AuthorizationCodeFlow {
  private readonly config: ReturnType<typeof validateConfig>;

  constructor(
    config: Auth0AuthorizationCodeFlowConfig,
    private readonly transactionStore: Auth0LoginTransactionStore,
    private readonly identityService: Auth0VerifiedIdentityResolver,
    private readonly userRepository: LocalAccountStatusRepository,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly sessionIssuer: AppSessionIssuer = new SessionService(),
  ) {
    this.config = validateConfig(config);
  }

  async start(
    clientType: Auth0ClientType,
    redirectUri: string,
  ): Promise<Auth0LoginStartResult> {
    if (clientType !== "web" && clientType !== "native") {
      throw new Auth0LoginFlowError("invalid_request");
    }

    const client = this.config.clients[clientType];
    if (!client.redirectUris.includes(redirectUri)) {
      throw new Auth0LoginFlowError("invalid_request");
    }

    const state = randomSecret();
    const nonce = randomSecret();
    const codeVerifier = randomSecret();
    const contextBinding = randomSecret();
    const createdAt = this.now();
    const expiresAt = createdAt + this.config.transactionTtlSeconds * 1000;
    const transaction: Auth0LoginTransaction = {
      clientType,
      clientId: client.clientId,
      redirectUri,
      codeVerifier,
      nonce,
      contextHash: hash(contextBinding),
      createdAt,
      expiresAt,
    };

    try {
      await this.transactionStore.save(state, transaction);
    } catch (error) {
      if (error instanceof OidcTransactionStoreError) {
        throw new Auth0LoginFlowError("temporarily_unavailable");
      }
      throw error;
    }

    const authorizationUrl = new URL("authorize", this.config.issuer);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", client.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", "openid");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set(
      "code_challenge",
      pkceChallenge(codeVerifier),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    return {
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: new Date(expiresAt).toISOString(),
      loginContextCookie: clientType === "web" ? contextBinding : undefined,
      nativeContextBinding:
        clientType === "native" ? contextBinding : undefined,
    };
  }

  async complete(callback: Auth0LoginCallback): Promise<Auth0LoginCompletion> {
    if (
      typeof callback.state !== "string" ||
      callback.state.length < 16 ||
      callback.state.length > 128 ||
      (typeof callback.code === "string") ===
        (typeof callback.error === "string")
    ) {
      throw new Auth0LoginFlowError("invalid_request");
    }

    let transaction: Auth0LoginTransaction | null;
    try {
      transaction = await this.transactionStore.consume(callback.state);
    } catch (error) {
      if (error instanceof OidcTransactionStoreError) {
        throw new Auth0LoginFlowError("temporarily_unavailable");
      }
      throw error;
    }

    const now = this.now();
    if (
      !transaction ||
      transaction.expiresAt <= now ||
      transaction.createdAt > now + 5_000
    ) {
      throw new Auth0LoginFlowError("invalid_transaction");
    }

    const registration = this.config.clients[transaction.clientType];
    if (
      transaction.clientId !== registration.clientId ||
      !registration.redirectUris.includes(transaction.redirectUri) ||
      transaction.expiresAt <= transaction.createdAt ||
      transaction.expiresAt - transaction.createdAt >
        this.config.transactionTtlSeconds * 1000
    ) {
      throw new Auth0LoginFlowError("invalid_transaction");
    }

    if (
      typeof callback.contextBinding !== "string" ||
      !constantTimeHexEqual(
        transaction.contextHash,
        hash(callback.contextBinding),
      )
    ) {
      throw new Auth0LoginFlowError("invalid_transaction");
    }

    if (callback.error !== undefined) {
      throw new Auth0LoginFlowError("provider_failure");
    }
    if (typeof callback.code !== "string") {
      throw new Auth0LoginFlowError("invalid_request");
    }

    const token = await this.exchangeAuthorizationCode(
      callback.code,
      transaction,
    );

    let resolution;
    try {
      resolution = await this.identityService.verifyAndResolveIdToken(
        token,
        transaction.nonce,
        transaction.clientId,
      );
    } catch (error) {
      if (error instanceof Auth0IdTokenVerificationError) {
        throw new Auth0LoginFlowError(
          error.failure === "jwks_unavailable"
            ? "temporarily_unavailable"
            : "provider_failure",
        );
      }
      throw error;
    }

    if (resolution.resolution.status !== "linked") {
      throw new Auth0LoginFlowError("not_linked");
    }

    const user = await this.userRepository.findUserById(
      resolution.resolution.userId,
    );
    if (!user?.isActive) {
      throw new Auth0LoginFlowError("account_unavailable");
    }

    try {
      const session = await this.sessionIssuer.create(
        user.id,
        transaction.clientType,
      );
      return {
        status: "authenticated",
        clientType: transaction.clientType,
        credential: session.credential,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      if (error instanceof AppSessionError) {
        throw new Auth0LoginFlowError("account_unavailable");
      }
      throw new Auth0LoginFlowError("temporarily_unavailable");
    }
  }

  private async exchangeAuthorizationCode(
    code: string,
    transaction: Auth0LoginTransaction,
  ): Promise<string> {
    const tokenUrl = new URL("oauth/token", this.config.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: transaction.clientId,
      code,
      redirect_uri: transaction.redirectUri,
      code_verifier: transaction.codeVerifier,
    });

    let response: Response;
    try {
      response = await this.fetcher(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(AUTH0_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Auth0LoginFlowError("temporarily_unavailable");
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (
      !response.ok ||
      (Number.isFinite(contentLength) &&
        contentLength > MAX_TOKEN_RESPONSE_BYTES) ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    ) {
      throw new Auth0LoginFlowError("provider_failure");
    }

    let tokenResponse: unknown;
    try {
      tokenResponse = await response.json();
    } catch {
      throw new Auth0LoginFlowError("provider_failure");
    }

    if (
      typeof tokenResponse !== "object" ||
      tokenResponse === null ||
      !("id_token" in tokenResponse) ||
      typeof tokenResponse.id_token !== "string" ||
      tokenResponse.id_token.length === 0 ||
      tokenResponse.id_token.length > MAX_TOKEN_RESPONSE_BYTES
    ) {
      throw new Auth0LoginFlowError("provider_failure");
    }

    return tokenResponse.id_token;
  }
}
