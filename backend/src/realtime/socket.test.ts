import { describe, expect, it } from "vitest";

import {
  allowSocketConnection,
  isSecureTransport,
} from "./socket";
import { RATE_LIMIT_POLICIES } from "../config/rate-limit";

describe("Socket.IO secure transport detection", () => {
  it("accepts a direct TLS connection", () => {
    expect(isSecureTransport(true, undefined, "203.0.113.8", "false")).toBe(
      true,
    );
  });

  describe("Socket.IO shared connection limits", () => {
    it("counts connection attempts by direct peer IP and fails closed on store errors", async () => {
      const keys: string[] = [];
      let count = 0;
      const counter = async (key: string) => {
        keys.push(key);
        return {
          count: ++count,
          ttlMs: 60_000,
        };
      };

      for (let attempt = 0; attempt < RATE_LIMIT_POLICIES.socketConnection.max; attempt += 1) {
        expect(await allowSocketConnection("192.0.2.15", counter)).toBe(true);
      }
      expect(await allowSocketConnection("192.0.2.15", counter)).toBe(false);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toContain("socket-connection");

      await expect(
        allowSocketConnection("192.0.2.15", async () => {
          throw new Error("Redis unavailable");
        }),
      ).rejects.toThrow("Redis unavailable");
      await expect(allowSocketConnection(undefined)).rejects.toThrow(
        "Socket peer address unavailable",
      );
    });
  });

  it("does not trust forwarded TLS from an unconfigured peer", () => {
    expect(isSecureTransport(false, "https", "203.0.113.8", "10.0.0.1")).toBe(
      false,
    );
  });

  it("accepts forwarded TLS only from a configured proxy address or subnet", () => {
    expect(isSecureTransport(false, "https", "10.0.0.8", "10.0.0.8")).toBe(
      true,
    );
    expect(isSecureTransport(false, "https", "10.0.0.8", "10.0.0.0/24")).toBe(
      true,
    );
  });

  it("rejects mixed forwarded protocols and untrusted-proxy configurations", () => {
    expect(
      isSecureTransport(false, "https,http", "10.0.0.8", "10.0.0.0/24"),
    ).toBe(false);
    expect(isSecureTransport(false, "https", "10.0.0.8", "false")).toBe(false);
  });
});
