import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { db } from "../../db";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { UsersRepository } from "../users/users.repository";
import { IdentityMappingService } from "../auth-identities/identity-mapping.service";
import { IdentityRepository } from "../auth-identities/identity.repository";
import { Auth0IdentityService } from "./auth0-identity.service";
import {
  Auth0IdTokenVerificationError,
  Auth0IdTokenVerifier,
  type Auth0IdTokenVerifierConfig,
  type JwksFetch,
} from "./auth0-id-token-verifier";

const issuer = "https://pronto-test.us.auth0.com/";
const webClientId = "web-client-id";
const mobileClientId = "mobile-client-id";
const expectedNonce = "nonce-generated-by-trusted-test-flow";
const config: Auth0IdTokenVerifierConfig = {
  issuer,
  clientIds: [webClientId, mobileClientId],
};

type SigningKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let signingKey: SigningKeyPair;
let otherSigningKey: SigningKeyPair;
let rotatedSigningKey: SigningKeyPair;

const signingJwk = async (key: CryptoKey, kid: string): Promise<JWK> => ({
  ...(await exportJWK(key)),
  kid,
  alg: "RS256",
  use: "sig",
});

let initialJwks: { keys: JWK[] } = { keys: [] };

let server: Server;
let jwksBody = JSON.stringify(initialJwks);
let jwksStatus = 200;
let jwksFetchCount = 0;
let localJwksUrl = "";

const setJwksResponse = (status: number, body: string) => {
  jwksStatus = status;
  jwksBody = body;
};

const localJwksFetch: JwksFetch = async (url, options) => {
  expect(url).toBe(new URL(".well-known/jwks.json", issuer).href);
  jwksFetchCount += 1;
  return fetch(localJwksUrl, {
    method: options.method,
    headers: options.headers,
    signal: options.signal,
    redirect: options.redirect,
  });
};

const createVerifier = (jwksOptions: { cooldownDuration?: number } = {}) =>
  new Auth0IdTokenVerifier(config, localJwksFetch, jwksOptions);

interface TokenOptions {
  key?: CryptoKey | Uint8Array;
  kid?: string;
  alg?: "RS256" | "HS256";
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  includeSubject?: boolean;
  nonce?: string;
  includeNonce?: boolean;
  expiresAt?: number;
  issuedAt?: number;
  notBefore?: number;
  azp?: string;
  additionalClaims?: Record<string, unknown>;
  jku?: string;
}

const nowInSeconds = () => Math.floor(Date.now() / 1000);

const createToken = async (options: TokenOptions = {}) => {
  const now = nowInSeconds();
  const alg = options.alg ?? "RS256";
  const claims: Record<string, unknown> = {
    ...options.additionalClaims,
    ...(options.includeNonce === false
      ? {}
      : { nonce: options.nonce ?? expectedNonce }),
    ...(options.azp === undefined ? {} : { azp: options.azp }),
  };
  let token = new SignJWT(claims).setProtectedHeader({
    alg,
    kid: options.kid ?? "key-1",
    typ: "JWT",
    ...(options.jku ? { jku: options.jku } : {}),
  });

  if (options.issuer !== undefined) {
    token = token.setIssuer(options.issuer);
  } else {
    token = token.setIssuer(issuer);
  }

  token = token.setAudience(options.audience ?? webClientId);
  if (options.subject !== undefined) {
    token = token.setSubject(options.subject);
  } else if (
    options.includeSubject !== false &&
    options.additionalClaims?.sub === undefined
  ) {
    token = token.setSubject("auth0|subject-exact-case");
  }

  token = token
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300);
  if (options.notBefore !== undefined) {
    token = token.setNotBefore(options.notBefore);
  }

  const privateKey =
    alg === "HS256"
      ? new TextEncoder().encode("test-only-unsupported-algorithm-secret")
      : (options.key ?? signingKey.privateKey);
  return token.sign(privateKey);
};

const expectInvalidToken = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({
    name: "Auth0IdTokenVerificationError",
    failure: "invalid_token",
  });
};

beforeAll(async () => {
  [signingKey, otherSigningKey, rotatedSigningKey] = await Promise.all([
    generateKeyPair("RS256"),
    generateKeyPair("RS256"),
    generateKeyPair("RS256"),
  ]);
  initialJwks = {
    keys: [await signingJwk(signingKey.publicKey, "key-1")],
  };
  jwksBody = JSON.stringify(initialJwks);

  server = createServer((request, response) => {
    if (request.url !== "/.well-known/jwks.json") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(jwksStatus, { "content-type": "application/json" });
    response.end(jwksBody);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local JWKS test server failed to start");
  }
  localJwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
});

beforeEach(() => {
  setJwksResponse(200, JSON.stringify(initialJwks));
  jwksFetchCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("Auth0 OIDC ID-token verification", () => {
  it("verifies an RS256 ID token and returns only approved identity claims", async () => {
    const verifier = createVerifier();
    const token = await createToken({
      additionalClaims: {
        email: "worker@example.test",
        email_verified: true,
        phone_number: "+15550000001",
        phone_number_verified: false,
        role: "admin",
        permissions: ["admin:all"],
      },
    });

    const identity = await verifier.verify(token, expectedNonce);

    expect(identity).toMatchObject({
      issuer,
      subject: "auth0|subject-exact-case",
      audience: [webClientId],
      email: "worker@example.test",
      emailVerified: true,
      phoneNumber: "+15550000001",
      phoneNumberVerified: false,
    });
    expect(identity).not.toHaveProperty("role");
    expect(identity).not.toHaveProperty("permissions");
    expect(identity).not.toHaveProperty("rawToken");
  });

  it("rejects an invalid signature", async () => {
    const verifier = createVerifier();
    const token = await createToken({ key: otherSigningKey.privateKey });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects a token with the wrong issuer", async () => {
    const verifier = createVerifier();
    const token = await createToken({
      issuer: "https://attacker.example/",
    });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects a token with the wrong audience", async () => {
    const verifier = createVerifier();
    const token = await createToken({ audience: "unconfigured-api" });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects a client ID not present in the configured allowlist", async () => {
    const verifier = new Auth0IdTokenVerifier(
      {
        issuer,
        clientIds: [webClientId],
      },
      localJwksFetch,
    );
    const token = await createToken({ audience: mobileClientId });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects an expired token", async () => {
    const verifier = createVerifier();
    const now = nowInSeconds();
    const token = await createToken({
      issuedAt: now - 120,
      expiresAt: now - 30,
    });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects an ID token issued outside the accepted age window", async () => {
    const verifier = createVerifier();
    const now = nowInSeconds();
    const token = await createToken({
      issuedAt: now - 700,
      expiresAt: now + 300,
    });

    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects an issued-at time beyond the allowed clock skew", async () => {
    const verifier = createVerifier();
    const now = nowInSeconds();
    const token = await createToken({
      issuedAt: now + 60,
      expiresAt: now + 300,
    });

    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects a token before its not-before time", async () => {
    const verifier = createVerifier();
    const token = await createToken({ notBefore: nowInSeconds() + 60 });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects a missing nonce and an incorrect nonce", async () => {
    const verifier = createVerifier();
    const missingNonce = await createToken({ includeNonce: false });
    const incorrectNonce = await createToken({ nonce: "different-nonce" });

    await expectInvalidToken(verifier.verify(missingNonce, expectedNonce));
    await expectInvalidToken(verifier.verify(incorrectNonce, expectedNonce));
  });

  it("rejects an unsupported signing algorithm", async () => {
    const verifier = createVerifier();
    const token = await createToken({ alg: "HS256" });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects a missing subject", async () => {
    const verifier = createVerifier();
    const token = await createToken({ includeSubject: false });
    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects optional contact claims with incorrect types", async () => {
    const verifier = createVerifier();
    const token = await createToken({
      additionalClaims: { email_verified: "true" },
    });

    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("rejects malformed token structure", async () => {
    const verifier = createVerifier();
    await expectInvalidToken(verifier.verify("not.a.jwt", expectedNonce));
  });

  it("refreshes JWKS on an unknown key and verifies with the rotated key", async () => {
    const verifier = createVerifier({ cooldownDuration: 0 });
    const originalToken = await createToken();
    await verifier.verify(originalToken, expectedNonce);

    const rotatedJwks = {
      keys: [await signingJwk(rotatedSigningKey.publicKey, "key-2")],
    };
    setJwksResponse(200, JSON.stringify(rotatedJwks));
    const rotatedToken = await createToken({
      key: rotatedSigningKey.privateKey,
      kid: "key-2",
    });

    const identity = await verifier.verify(rotatedToken, expectedNonce);
    expect(identity.subject).toBe("auth0|subject-exact-case");
    expect(jwksFetchCount).toBe(2);
  });

  it("rejects unknown keys without fetching JWKS repeatedly during cooldown", async () => {
    const verifier = createVerifier();
    const firstToken = await createToken();
    await verifier.verify(firstToken, expectedNonce);

    const unknownKeyToken = await createToken({
      key: rotatedSigningKey.privateKey,
      kid: "unrecognized-key",
    });
    await expectInvalidToken(verifier.verify(unknownKeyToken, expectedNonce));
    await expectInvalidToken(verifier.verify(unknownKeyToken, expectedNonce));
    expect(jwksFetchCount).toBe(1);
  });

  it("fails closed when the JWKS provider is unavailable", async () => {
    const verifier = createVerifier();
    setJwksResponse(503, "{}");
    const token = await createToken();

    await expect(verifier.verify(token, expectedNonce)).rejects.toMatchObject({
      name: "Auth0IdTokenVerificationError",
      failure: "jwks_unavailable",
    });
  });

  it("accepts multi-audience ID tokens only with a valid authorized party", async () => {
    const verifier = createVerifier();
    const validToken = await createToken({
      audience: [webClientId, mobileClientId],
      azp: mobileClientId,
    });
    const invalidToken = await createToken({
      audience: [webClientId, mobileClientId],
      azp: "unconfigured-client",
    });

    await expect(
      verifier.verify(validToken, expectedNonce),
    ).resolves.toMatchObject({
      audience: [webClientId, mobileClientId],
    });
    await expectInvalidToken(verifier.verify(invalidToken, expectedNonce));
  });

  it("binds an ID token to the client selected by its OIDC transaction", async () => {
    const verifier = createVerifier();
    const webToken = await createToken({ audience: webClientId });
    const nativeToken = await createToken({
      audience: [webClientId, mobileClientId],
      azp: mobileClientId,
    });

    await expect(
      verifier.verify(webToken, expectedNonce, webClientId),
    ).resolves.toMatchObject({ audience: [webClientId] });
    await expectInvalidToken(
      verifier.verify(webToken, expectedNonce, mobileClientId),
    );
    await expectInvalidToken(
      verifier.verify(nativeToken, expectedNonce, webClientId),
    );
  });

  it("rejects an authorized party that disagrees with a single audience", async () => {
    const verifier = createVerifier();
    const token = await createToken({
      audience: webClientId,
      azp: mobileClientId,
    });

    await expectInvalidToken(verifier.verify(token, expectedNonce));
  });

  it("does not use a token-provided key URL", async () => {
    const verifier = createVerifier();
    const token = await createToken({ jku: "https://attacker.example/keys" });

    await expect(verifier.verify(token, expectedNonce)).resolves.toMatchObject({
      subject: "auth0|subject-exact-case",
    });
    expect(jwksFetchCount).toBe(1);
  });

  it("resolves verified identities through the local mapping without authorizing roles", async () => {
    const phoneNumber = `+1${Date.now()}901`;
    const [user] = await db
      .insert(users)
      .values({
        phoneNumber,
        fullName: "OIDC verifier test user",
        role: "worker",
        isActive: false,
      })
      .returning();
    const identityRepository = new IdentityRepository();
    const identityMappingService = new IdentityMappingService(
      identityRepository,
    );
    const auth0IdentityService = new Auth0IdentityService(
      createVerifier(),
      identityMappingService,
    );
    const token = await createToken();

    try {
      await identityRepository.createIdentityMapping(
        { issuer, subject: "auth0|subject-exact-case" },
        user.id,
      );

      const { identity, resolution } =
        await auth0IdentityService.verifyAndResolveIdToken(
          token,
          expectedNonce,
        );

      expect(resolution).toEqual({ status: "linked", userId: user.id });
      expect(identity).not.toHaveProperty("role");
      await expect(
        new UsersRepository().findUserById(user.id),
      ).resolves.toMatchObject({ role: "worker", isActive: false });
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("returns not-linked for a verified unknown identity without creating a user", async () => {
    const userCreation = vi.spyOn(UsersRepository.prototype, "createUser");
    const auth0IdentityService = new Auth0IdentityService(
      createVerifier(),
      new IdentityMappingService(new IdentityRepository()),
    );
    const token = await createToken();

    const result = await auth0IdentityService.verifyAndResolveIdToken(
      token,
      expectedNonce,
    );

    expect(result.resolution).toEqual({ status: "not_linked" });
    expect(userCreation).not.toHaveBeenCalled();
  });
});
