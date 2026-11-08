import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { env } from "../../config/env";
import {
  SessionRepository,
  type AppSessionClientType,
  type SessionRepositoryPort,
} from "./session.repository";

export class AppSessionError extends Error {
  constructor(
    public readonly reason:
      | "invalid_credential"
      | "account_unavailable"
      | "worker_unavailable",
  ) {
    super(reason);
    this.name = "AppSessionError";
  }
}

export interface AuthenticatedAppSession {
  id: string;
  userId: number;
  role: "customer" | "worker" | "admin";
  clientType: AppSessionClientType;
  csrfTokenHash: string | null;
}

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const constantTimeHexEqual = (left: string, right: string) => {
  if (!/^[\da-f]{64}$/i.test(left) || !/^[\da-f]{64}$/i.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const parseCredential = (credential: string) => {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
      credential,
    );
  return match ? { id: match[1], secret: match[2] } : null;
};

export class SessionService {
  constructor(
    private readonly repository: SessionRepositoryPort = new SessionRepository(),
    private readonly ttlSeconds = env.APP_SESSION_TTL_SECONDS,
    private readonly now = () => Date.now(),
    private readonly randomSecret = () => randomBytes(32).toString("base64url"),
    private readonly newId = () => randomUUID(),
  ) {}

  async create(
    userId: number,
    clientType: AppSessionClientType,
  ): Promise<{
    credential: string;
    csrfToken: string | null;
    expiresAt: Date;
    id: string;
  }> {
    const user = await this.repository.findUser(userId);
    if (!user?.isActive) {
      throw new AppSessionError("account_unavailable");
    }

    const id = this.newId();
    const secret = this.randomSecret();
    const credential = `${id}.${secret}`;
    const csrfToken = clientType === "web" ? this.randomSecret() : null;
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + this.ttlSeconds * 1000);

    await this.repository.create({
      id,
      userId,
      clientType,
      tokenHash: hash(secret),
      csrfTokenHash: csrfToken ? hash(csrfToken) : null,
      createdAt,
      expiresAt,
    });

    return { credential, csrfToken, expiresAt, id };
  }

  async authenticate(
    credential: string,
    clientType: AppSessionClientType,
  ): Promise<AuthenticatedAppSession> {
    const parsed = parseCredential(credential);
    if (!parsed) {
      throw new AppSessionError("invalid_credential");
    }

    const session = await this.repository.findById(parsed.id);
    if (
      !session ||
      session.clientType !== clientType ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= this.now() ||
      !session.isActive ||
      !constantTimeHexEqual(session.tokenHash, hash(parsed.secret))
    ) {
      throw new AppSessionError("invalid_credential");
    }

    if (!(await this.repository.markUsed(session.id, new Date(this.now())))) {
      throw new AppSessionError("invalid_credential");
    }

    return {
      id: session.id,
      userId: session.userId,
      role: session.role,
      clientType: session.clientType,
      csrfTokenHash: session.csrfTokenHash,
    };
  }

  async authenticateVerifier(
    id: string,
    tokenHash: string,
    clientType: AppSessionClientType,
  ): Promise<AuthenticatedAppSession | null> {
    const session = await this.repository.findById(id);
    if (
      !session ||
      session.clientType !== clientType ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= this.now() ||
      !session.isActive ||
      !constantTimeHexEqual(session.tokenHash, tokenHash)
    ) {
      return null;
    }

    return {
      id: session.id,
      userId: session.userId,
      role: session.role,
      clientType: session.clientType,
      csrfTokenHash: session.csrfTokenHash,
    };
  }

  async verifierForCredential(
    credential: string,
  ): Promise<{ id: string; tokenHash: string }> {
    const parsed = parseCredential(credential);
    if (!parsed) {
      throw new AppSessionError("invalid_credential");
    }
    return { id: parsed.id, tokenHash: hash(parsed.secret) };
  }

  async authorizeWorker(
    userId: number,
    requireAvailable = false,
  ): Promise<void> {
    const worker = await this.repository.findWorkerProfile(userId);
    if (
      !worker ||
      worker.approvalStatus !== "approved" ||
      worker.deletedAt !== null ||
      worker.status === "suspended" ||
      (requireAvailable && worker.status !== "available")
    ) {
      throw new AppSessionError("worker_unavailable");
    }
  }

  async verifyCsrfToken(
    session: AuthenticatedAppSession,
    token: string | undefined,
  ): Promise<boolean> {
    if (session.clientType !== "web" || !token || !session.csrfTokenHash) {
      return false;
    }
    return constantTimeHexEqual(session.csrfTokenHash, hash(token));
  }

  async renewCsrfToken(sessionId: string): Promise<string> {
    const token = this.randomSecret();
    const updated = await this.repository.updateCsrfTokenHash(
      sessionId,
      hash(token),
      new Date(this.now()),
    );
    if (!updated) {
      throw new AppSessionError("invalid_credential");
    }
    return token;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.repository.revoke(sessionId, new Date(this.now()));
  }

  async revokeCredential(
    credential: string,
    clientType: AppSessionClientType,
    csrfToken?: string,
  ): Promise<boolean> {
    const parsed = parseCredential(credential);
    if (!parsed) {
      return false;
    }

    const session = await this.repository.findById(parsed.id);
    if (
      !session ||
      session.clientType !== clientType ||
      !constantTimeHexEqual(session.tokenHash, hash(parsed.secret))
    ) {
      return false;
    }

    if (
      clientType === "web" &&
      (!session.csrfTokenHash ||
        !csrfToken ||
        !constantTimeHexEqual(session.csrfTokenHash, hash(csrfToken)))
    ) {
      return false;
    }

    await this.repository.revoke(session.id, new Date(this.now()));
    return true;
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.repository.revokeAllForUser(userId, new Date(this.now()));
  }
}
