import { createHash } from "node:crypto";
import { z } from "zod";

import { redis } from "../../config/redis";

export interface Auth0LoginTransaction {
  clientType: "web" | "native";
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  nonce: string;
  contextHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface Auth0LoginTransactionStore {
  save(state: string, transaction: Auth0LoginTransaction): Promise<void>;
  consume(state: string): Promise<Auth0LoginTransaction | null>;
}

export class OidcTransactionStoreError extends Error {
  constructor() {
    super("OIDC transaction storage is unavailable or invalid");
    this.name = "OidcTransactionStoreError";
  }
}

type RedisTransactionClient = Pick<typeof redis, "set" | "eval">;

const transactionSchema = z
  .object({
    clientType: z.enum(["web", "native"]),
    clientId: z.string().min(1),
    redirectUri: z.string().min(1),
    codeVerifier: z.string().min(43).max(128),
    nonce: z.string().min(1),
    contextHash: z.string().regex(/^[\da-f]{64}$/),
    createdAt: z.number().finite(),
    expiresAt: z.number().finite(),
  })
  .strict();

const consumeScript = `
local transaction = redis.call("GET", KEYS[1])
if transaction then
  redis.call("DEL", KEYS[1])
end
return transaction
`;

const transactionKey = (state: string) =>
  `auth0:oidc:transactions:${createHash("sha256")
    .update(state)
    .digest("base64url")}`;

export class RedisAuth0LoginTransactionStore implements Auth0LoginTransactionStore {
  constructor(private readonly client: RedisTransactionClient = redis) {}

  async save(state: string, transaction: Auth0LoginTransaction): Promise<void> {
    const expiresInSeconds = Math.ceil(
      (transaction.expiresAt - transaction.createdAt) / 1000,
    );
    if (expiresInSeconds < 1) {
      throw new OidcTransactionStoreError();
    }

    let result: string | null;
    try {
      result = await this.client.set(
        transactionKey(state),
        JSON.stringify(transaction),
        { EX: expiresInSeconds, NX: true },
      );
    } catch {
      throw new OidcTransactionStoreError();
    }

    if (result !== "OK") {
      throw new OidcTransactionStoreError();
    }
  }

  async consume(state: string): Promise<Auth0LoginTransaction | null> {
    let value: unknown;
    try {
      value = await this.client.eval(consumeScript, {
        keys: [transactionKey(state)],
        arguments: [],
      });
    } catch {
      throw new OidcTransactionStoreError();
    }

    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new OidcTransactionStoreError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new OidcTransactionStoreError();
    }

    const transaction = transactionSchema.safeParse(parsed);
    if (!transaction.success) {
      throw new OidcTransactionStoreError();
    }

    return transaction.data;
  }
}
