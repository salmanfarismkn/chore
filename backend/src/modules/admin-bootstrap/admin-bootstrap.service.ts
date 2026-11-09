import { timingSafeEqual } from "node:crypto";

import {
  AdminBootstrapRepository,
  type AdminBootstrapResult,
} from "./admin-bootstrap.repository";

export class AdminBootstrapError extends Error {
  constructor(
    public readonly reason:
      | "invalid_secret"
      | "already_completed"
      | "administrator_exists"
      | "user_not_eligible"
      | "database_unavailable",
  ) {
    super(reason);
    this.name = "AdminBootstrapError";
  }
}

const isStrongBootstrapSecret = (secret: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    return false;
  }
  const decoded = Buffer.from(secret, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === secret;
};

const secretsMatch = (configured: string, provided: string) => {
  const expected = Buffer.from(configured, "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export class AdminBootstrapService {
  constructor(
    private readonly repository = new AdminBootstrapRepository(),
    private readonly configuredSecret: string | undefined = process.env
      .ADMIN_BOOTSTRAP_SECRET,
  ) {}

  async provision(
    userId: number,
    providedSecret: string | undefined,
  ): Promise<Extract<AdminBootstrapResult, { status: "created" }>> {
    if (
      !this.configuredSecret ||
      !isStrongBootstrapSecret(this.configuredSecret) ||
      !providedSecret ||
      !secretsMatch(this.configuredSecret, providedSecret)
    ) {
      throw new AdminBootstrapError("invalid_secret");
    }

    let result: AdminBootstrapResult;
    try {
      result = await this.repository.provision(userId);
    } catch {
      throw new AdminBootstrapError("database_unavailable");
    }
    if (result.status !== "created") {
      throw new AdminBootstrapError(result.status);
    }

    return result;
  }
}
