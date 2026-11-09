import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Auth0AuthorizationCodeFlow,
  auth0AuthorizationCodeFlowConfigFromEnvironment,
  type Auth0AuthorizationCodeFlowConfig,
  type Auth0ClientType,
  type Auth0LoginStartResult,
} from "./auth0-authorization-code-flow";
import {
  OidcTransactionStoreError,
  type Auth0LoginTransaction,
  type Auth0LoginTransactionStore,
} from "./auth0-login-transaction";
import { Auth0IdTokenVerificationError } from "./auth0-id-token-verifier";

const issuer = "https://pronto-test.us.auth0.com/";
const webRedirectUri = "https://web.example.test/auth/callback";
const nativeRedirectUri = "com.example.prontoplus://auth/callback";
const webClientId = "web-test-client";
const nativeClientId = "native-test-client";

const config: Auth0AuthorizationCodeFlowConfig = {
  issuer,
  clients: {
    web: {
      clientId: webClientId,
      redirectUris: [webRedirectUri],
    },
    native: {
      clientId: nativeClientId,
      redirectUris: [nativeRedirectUri],
    },
  },
};
const contextBindings = new Map<string, string>();

class MemoryTransactionStore implements Auth0LoginTransactionStore {
  readonly transactions = new Map<string, Auth0LoginTransaction>();

  async save(state: string, transaction: Auth0LoginTransaction) {
    if (this.transactions.has(state)) {
      throw new Error("state collision");
    }
    this.transactions.set(state, transaction);
  }

  async consume(state: string) {
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    return transaction ?? null;
  }
}

const extractState = (started: Auth0LoginStartResult) => {
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  const contextBinding =
    started.loginContextCookie ?? started.nativeContextBinding;
  if (contextBinding) {
    contextBindings.set(state, contextBinding);
  }
  return state;
};

const completeFlow = (
  flow: Auth0AuthorizationCodeFlow,
  callback: Parameters<Auth0AuthorizationCodeFlow["complete"]>[0],
) =>
  flow.complete({
    ...callback,
    contextBinding:
      callback.contextBinding ?? contextBindings.get(callback.state),
  });

const createTokenResponse = (idToken = "signed-test-id-token", status = 200) =>
  new Response(
    JSON.stringify({
      token_type: "Bearer",
      id_token: idToken,
      access_token: "must-not-be-returned",
      refresh_token: "must-not-be-returned",
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );

const createHarness = (
  overrides: {
    identityResolution?:
      | { status: "not_linked" }
      | { status: "linked"; userId: number };
    isActive?: boolean;
    now?: () => number;
    fetcher?: typeof fetch;
    verifierFailure?: boolean;
  } = {},
) => {
  const store = new MemoryTransactionStore();
  const verifyAndResolveIdToken = vi.fn(async () => {
    if (overrides.verifierFailure) {
      throw new Auth0IdTokenVerificationError("invalid_token");
    }
    return {
      resolution: overrides.identityResolution ?? {
        status: "linked" as const,
        userId: 42,
      },
    };
  });
  const findUserById = vi.fn(async () =>
    overrides.identityResolution?.status === "not_linked"
      ? null
      : { id: 42, isActive: overrides.isActive ?? true },
  );
  const fetcher =
    overrides.fetcher ??
    (vi.fn(async () => createTokenResponse()) as unknown as typeof fetch);
  const sessionIssuer = {
    create: vi.fn(async () => ({
      credential: "session-credential",
      csrfToken: "csrf-token",
      expiresAt: new Date(1_800_000_060_000),
    })),
  };
  const flow = new Auth0AuthorizationCodeFlow(
    config,
    store,
    { verifyAndResolveIdToken },
    { findUserById },
    fetcher,
    overrides.now,
    sessionIssuer,
  );

  return {
    flow,
    store,
    verifyAndResolveIdToken,
    findUserById,
    fetcher,
    sessionIssuer,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Auth0 authorization-code + PKCE flow", () => {
  it("builds separate exact client registrations from environment configuration", () => {
    const environmentConfig = auth0AuthorizationCodeFlowConfigFromEnvironment({
      AUTH0_ISSUER: issuer,
      AUTH0_CLIENT_IDS: `${webClientId},${nativeClientId}`,
      AUTH0_WEB_CLIENT_ID: webClientId,
      AUTH0_NATIVE_CLIENT_ID: nativeClientId,
      AUTH0_WEB_REDIRECT_URIS: webRedirectUri,
      AUTH0_NATIVE_REDIRECT_URIS: nativeRedirectUri,
    });

    expect(environmentConfig.clients).toEqual({
      web: { clientId: webClientId, redirectUris: [webRedirectUri] },
      native: { clientId: nativeClientId, redirectUris: [nativeRedirectUri] },
    });
    expect(() =>
      auth0AuthorizationCodeFlowConfigFromEnvironment({
        AUTH0_ISSUER: issuer,
        AUTH0_CLIENT_IDS: `${webClientId},unconfigured-client`,
        AUTH0_WEB_CLIENT_ID: webClientId,
        AUTH0_NATIVE_CLIENT_ID: nativeClientId,
        AUTH0_WEB_REDIRECT_URIS: webRedirectUri,
        AUTH0_NATIVE_REDIRECT_URIS: nativeRedirectUri,
      }),
    ).toThrow(/exactly match/);
  });

  it("creates a random, expiring transaction and constructs an S256 authorization request", async () => {
    const now = 1_800_000_000_000;
    const { flow, store } = createHarness({ now: () => now });
    const started = await flow.start("web", webRedirectUri);
    const authorization = new URL(started.authorizationUrl);
    const state = authorization.searchParams.get("state")!;
    const transaction = store.transactions.get(state)!;
    const expectedChallenge = createHash("sha256")
      .update(transaction.codeVerifier)
      .digest("base64url");

    expect(authorization.origin + authorization.pathname).toBe(
      "https://pronto-test.us.auth0.com/authorize",
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe(webClientId);
    expect(authorization.searchParams.get("redirect_uri")).toBe(webRedirectUri);
    expect(authorization.searchParams.get("scope")).toBe("openid");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("code_challenge")).toBe(
      expectedChallenge,
    );
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.expiresAt).toBe(new Date(now + 600_000).toISOString());
    expect(transaction).toMatchObject({
      clientType: "web",
      clientId: webClientId,
      redirectUri: webRedirectUri,
      createdAt: now,
      expiresAt: now + 600_000,
    });
  });

  it("selects the separately configured native registration", async () => {
    const { flow, store } = createHarness();
    const started = await flow.start("native", nativeRedirectUri);
    const authorization = new URL(started.authorizationUrl);
    const transaction = store.transactions.get(extractState(started));

    expect(authorization.searchParams.get("client_id")).toBe(nativeClientId);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      nativeRedirectUri,
    );
    expect(transaction).toMatchObject({
      clientType: "native",
      clientId: nativeClientId,
      redirectUri: nativeRedirectUri,
    });
  });

  it("rejects unsupported client types and unapproved redirects", async () => {
    const { flow } = createHarness();

    await expect(
      flow.start("admin" as Auth0ClientType, webRedirectUri),
    ).rejects.toMatchObject({
      name: "Auth0LoginFlowError",
      failure: "invalid_request",
    });
    await expect(
      flow.start("web", "https://attacker.example/callback"),
    ).rejects.toMatchObject({ failure: "invalid_request" });
  });

  it("rejects a callback after its transaction expires", async () => {
    let now = 1_800_000_000_000;
    const { flow, store, fetcher } = createHarness({ now: () => now });
    const started = await flow.start("web", webRedirectUri);
    const state = extractState(started);
    now += 600_000;

    await expect(
      completeFlow(flow, { state, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "invalid_transaction" });
    expect(store.transactions.has(state)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects transactions whose selected client or redirect no longer matches configuration", async () => {
    const { flow, store, fetcher } = createHarness();
    const redirectState = extractState(await flow.start("web", webRedirectUri));
    store.transactions.get(redirectState)!.redirectUri =
      "https://attacker.example/callback";

    await expect(
      completeFlow(flow, { state: redirectState, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "invalid_transaction" });

    const clientState = extractState(await flow.start("web", webRedirectUri));
    store.transactions.get(clientState)!.clientId = nativeClientId;
    await expect(
      completeFlow(flow, { state: clientState, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "invalid_transaction" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a callback whose context binding was substituted", async () => {
    const { flow, fetcher } = createHarness();
    const firstState = extractState(await flow.start("web", webRedirectUri));
    const secondState = extractState(await flow.start("web", webRedirectUri));

    await expect(
      flow.complete({
        state: firstState,
        code: "authorization-code",
        contextBinding: contextBindings.get(secondState),
      }),
    ).rejects.toMatchObject({ failure: "invalid_transaction" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when transaction storage is unavailable", async () => {
    const unavailableStore: Auth0LoginTransactionStore = {
      save: async () => {
        throw new OidcTransactionStoreError();
      },
      consume: async () => {
        throw new OidcTransactionStoreError();
      },
    };
    const flow = new Auth0AuthorizationCodeFlow(
      config,
      unavailableStore,
      { verifyAndResolveIdToken: vi.fn() },
      { findUserById: vi.fn() },
    );

    await expect(flow.start("web", webRedirectUri)).rejects.toMatchObject({
      failure: "temporarily_unavailable",
    });
    await expect(
      completeFlow(flow, {
        state: "valid-state-123456",
        code: "authorization-code",
      }),
    ).rejects.toMatchObject({ failure: "temporarily_unavailable" });
  });

  it("atomically consumes a callback state so concurrent replays cannot both proceed", async () => {
    const { flow } = createHarness();
    const state = extractState(await flow.start("web", webRedirectUri));

    const attempts = await Promise.allSettled([
      completeFlow(flow, { state, code: "authorization-code" }),
      completeFlow(flow, { state, code: "authorization-code" }),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
  });

  it("rejects unknown and malformed state before token exchange", async () => {
    const { flow, fetcher } = createHarness();

    await expect(
      completeFlow(flow, { state: "unknown-state-value", code: "code" }),
    ).rejects.toMatchObject({ failure: "invalid_transaction" });
    await expect(
      completeFlow(flow, { state: "", code: "code" }),
    ).rejects.toMatchObject({
      failure: "invalid_request",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("consumes provider error callbacks without exchanging codes or exposing details", async () => {
    const { flow, fetcher } = createHarness();
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, error: "access_denied" }),
    ).rejects.toMatchObject({ failure: "provider_failure" });
    await expect(
      completeFlow(flow, { state, error: "access_denied" }),
    ).rejects.toMatchObject({ failure: "invalid_transaction" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exchanges code over HTTPS with the bound client, redirect, and PKCE verifier", async () => {
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        createTokenResponse(),
    );
    const { flow, store, verifyAndResolveIdToken } = createHarness({
      fetcher: fetcher as unknown as typeof fetch,
    });
    const started = await flow.start("native", nativeRedirectUri);
    const state = extractState(started);
    const transaction = store.transactions.get(state)!;
    const result = await completeFlow(flow, {
      state,
      code: "single-use-code",
    });
    const [url, options] = fetcher.mock.calls[0]!;
    const form = new URLSearchParams(String(options?.body));

    expect(String(url)).toBe("https://pronto-test.us.auth0.com/oauth/token");
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
    });
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(nativeClientId);
    expect(form.get("code")).toBe("single-use-code");
    expect(form.get("redirect_uri")).toBe(nativeRedirectUri);
    expect(form.get("code_verifier")).toBe(transaction.codeVerifier);
    expect(verifyAndResolveIdToken).toHaveBeenCalledWith(
      "signed-test-id-token",
      transaction.nonce,
      nativeClientId,
    );
    expect(result).toMatchObject({
      status: "authenticated",
      clientType: "native",
      credential: "session-credential",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
  });

  it("rejects authorization-code exchange failures without verifying or resolving", async () => {
    const fetcher = vi.fn(async () =>
      createTokenResponse("", 400),
    ) as unknown as typeof fetch;
    const { flow, verifyAndResolveIdToken } = createHarness({ fetcher });
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, code: "bad-code" }),
    ).rejects.toMatchObject({
      failure: "provider_failure",
    });
    expect(verifyAndResolveIdToken).not.toHaveBeenCalled();
  });

  it("fails closed with an unavailable result when Auth0 cannot be reached", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("network error with no credentials");
    }) as unknown as typeof fetch;
    const { flow, verifyAndResolveIdToken } = createHarness({ fetcher });
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "temporarily_unavailable" });
    expect(verifyAndResolveIdToken).not.toHaveBeenCalled();
  });

  it("rejects invalid ID tokens and nonce failures without local account lookup", async () => {
    const { flow, findUserById } = createHarness({ verifierFailure: true });
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "provider_failure" });
    expect(findUserById).not.toHaveBeenCalled();
  });

  it("returns an explicit not-linked failure without creating or linking accounts", async () => {
    const { flow, findUserById, verifyAndResolveIdToken } = createHarness({
      identityResolution: { status: "not_linked" },
    });
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "not_linked" });
    expect(findUserById).not.toHaveBeenCalled();
    expect(verifyAndResolveIdToken).toHaveBeenCalledOnce();
    expect(verifyAndResolveIdToken.mock.calls[0]).toHaveLength(3);
  });

  it("rejects inactive local accounts without changing role or account state", async () => {
    const localAccount = {
      id: 42,
      isActive: false,
      role: "worker",
    };
    const findUserById = vi.fn(async () => localAccount);
    const inactiveStore = new MemoryTransactionStore();
    const inactiveFlow = new Auth0AuthorizationCodeFlow(
      config,
      inactiveStore,
      {
        verifyAndResolveIdToken: vi.fn(async () => ({
          resolution: { status: "linked" as const, userId: 42 },
        })),
      },
      { findUserById },
      async () => createTokenResponse(),
    );
    const inactiveState = extractState(
      await inactiveFlow.start("web", webRedirectUri),
    );

    await expect(
      completeFlow(inactiveFlow, {
        state: inactiveState,
        code: "authorization-code",
      }),
    ).rejects.toMatchObject({ failure: "account_unavailable" });
    expect(findUserById).toHaveBeenCalledWith(42);
    expect(localAccount).toEqual({
      id: 42,
      isActive: false,
      role: "worker",
    });
  });

  it("does not create users, assign roles, activate accounts, or return provider tokens", async () => {
    const localAccount = { id: 42, isActive: true, role: "customer" };
    const identityResolver = {
      verifyAndResolveIdToken: vi.fn(async () => ({
        resolution: { status: "linked" as const, userId: 42 },
      })),
    };
    const findUserById = vi.fn(async () => localAccount);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id_token: "signed-test-id-token",
            access_token: "provider-access-token",
            refresh_token: "provider-refresh-token",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const sessionIssuer = {
      create: vi.fn(async () => ({
        credential: "opaque-native-session-secret",
        csrfToken: null,
        expiresAt: new Date("2026-11-06T09:00:00.000Z"),
      })),
    };
    const flow = new Auth0AuthorizationCodeFlow(
      config,
      new MemoryTransactionStore(),
      identityResolver,
      { findUserById },
      fetcher as unknown as typeof fetch,
      Date.now,
      sessionIssuer,
    );
    const state = extractState(await flow.start("web", webRedirectUri));
    const result = await completeFlow(flow, {
      state,
      code: "authorization-code",
    });

    expect(identityResolver).not.toHaveProperty("linkIdentityToUser");
    expect(localAccount).toEqual({
      id: 42,
      isActive: true,
      role: "customer",
    });
    expect(result).toEqual({
      status: "authenticated",
      clientType: "web",
      credential: "opaque-native-session-secret",
      csrfToken: null,
      expiresAt: new Date("2026-11-06T09:00:00.000Z"),
    });
    expect(sessionIssuer.create).toHaveBeenCalledWith(42, "web");
    expect(JSON.stringify(result)).not.toContain("provider-access-token");
    expect(JSON.stringify(result)).not.toContain("provider-refresh-token");
  });

  it("fails closed when the verifier rejects a token with an incorrect nonce", async () => {
    const verifyAndResolveIdToken = vi.fn(async () => {
      throw new Auth0IdTokenVerificationError("invalid_token");
    });
    const fetcher = vi.fn(async () => createTokenResponse());
    const flow = new Auth0AuthorizationCodeFlow(
      config,
      new MemoryTransactionStore(),
      { verifyAndResolveIdToken },
      { findUserById: vi.fn(async () => ({ id: 42, isActive: true })) },
      fetcher as unknown as typeof fetch,
    );
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "provider_failure" });
  });

  it("reports signing-key unavailability without accepting the identity", async () => {
    const verifyAndResolveIdToken = vi.fn(async () => {
      throw new Auth0IdTokenVerificationError("jwks_unavailable");
    });
    const fetcher = vi.fn(async () => createTokenResponse());
    const flow = new Auth0AuthorizationCodeFlow(
      config,
      new MemoryTransactionStore(),
      { verifyAndResolveIdToken },
      { findUserById: vi.fn(async () => ({ id: 42, isActive: true })) },
      fetcher as unknown as typeof fetch,
    );
    const state = extractState(await flow.start("web", webRedirectUri));

    await expect(
      completeFlow(flow, { state, code: "authorization-code" }),
    ).rejects.toMatchObject({ failure: "temporarily_unavailable" });
  });

  it("rejects unsafe flow configuration instead of accepting wildcard redirects", () => {
    expect(
      () =>
        new Auth0AuthorizationCodeFlow(
          {
            ...config,
            clients: {
              ...config.clients,
              web: {
                clientId: webClientId,
                redirectUris: ["https://*.example.test/callback"],
              },
            },
          },
          new MemoryTransactionStore(),
          { verifyAndResolveIdToken: vi.fn() },
          { findUserById: vi.fn() },
        ),
    ).toThrow(/redirect URI is invalid/);
    expect(
      () =>
        new Auth0AuthorizationCodeFlow(
          {
            ...config,
            clients: {
              ...config.clients,
              native: {
                clientId: nativeClientId,
                redirectUris: ["javascript:alert(1)"],
              },
            },
          },
          new MemoryTransactionStore(),
          { verifyAndResolveIdToken: vi.fn() },
          { findUserById: vi.fn() },
        ),
    ).toThrow(/redirect URI is invalid/);
  });
});
