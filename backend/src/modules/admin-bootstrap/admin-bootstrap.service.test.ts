import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  AdminBootstrapError,
  AdminBootstrapService,
} from "./admin-bootstrap.service";
import { runAdminBootstrapCommand } from "../../scripts/bootstrap-admin";

const secret = () => randomBytes(32).toString("base64url");

describe("initial administrator bootstrap service", () => {
  it("requires a configured high-entropy secret and never includes it in errors", async () => {
    const configuredSecret = secret();
    const repository = { provision: vi.fn() };
    const service = new AdminBootstrapService(
      repository as never,
      configuredSecret,
    );

    await expect(service.provision(4, "wrong secret")).rejects.toMatchObject({
      name: "AdminBootstrapError",
      reason: "invalid_secret",
      message: "invalid_secret",
    });
    expect(repository.provision).not.toHaveBeenCalled();

    await expect(
      new AdminBootstrapService(repository as never, "short").provision(
        4,
        "short",
      ),
    ).rejects.toMatchObject({ reason: "invalid_secret" });
  });

  it("fails closed on database errors without logging the configured secret", async () => {
    const configuredSecret = secret();
    const repository = {
      provision: vi.fn().mockRejectedValue(new Error(configuredSecret)),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new AdminBootstrapService(
      repository as never,
      configuredSecret,
    );

    await expect(service.provision(4, configuredSecret)).rejects.toMatchObject({
      message: "database_unavailable",
      reason: "database_unavailable",
    });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not print a bootstrap secret when the command fails", async () => {
    const configuredSecret = secret();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const infoLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const service = {
      provision: vi.fn().mockRejectedValue(new Error(configuredSecret)),
    };

    await expect(
      runAdminBootstrapCommand(["4"], configuredSecret, service as never),
    ).resolves.toBe(1);
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
      configuredSecret,
    );
    expect(infoLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    infoLog.mockRestore();
  });
});
