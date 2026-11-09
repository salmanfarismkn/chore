import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";

import { env } from "../config/env";
import {
  AppSessionError,
  SessionService,
} from "../modules/sessions/session.service";
import { SESSION_COOKIE_NAME } from "../plugins/session-auth";
import { registerWorkerSocket } from "./worker-socket";
import {
  checkDistributedRateLimit,
  ipRateLimitIdentity,
  RATE_LIMIT_POLICIES,
  sharedRateLimitCounter,
  type RateLimitCounter,
} from "../config/rate-limit";

const SESSION_REVALIDATION_INTERVAL_MS = 15_000;

let io: SocketIOServer | null = null;

export async function allowSocketConnection(
  remoteAddress: string | undefined,
  counter: RateLimitCounter = sharedRateLimitCounter,
): Promise<boolean> {
  const identity = ipRateLimitIdentity(remoteAddress);
  if (!identity) {
    throw new Error("Socket peer address unavailable");
  }
  const decision = await checkDistributedRateLimit(
    RATE_LIMIT_POLICIES.socketConnection,
    identity,
    counter,
  );
  return decision.allowed;
}

const cookieValue = (header: string | undefined, name: string) => {
  if (!header) {
    return undefined;
  }
  const encodedName = `${name}=`;
  const entry = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(encodedName));
  if (entry.length !== 1) {
    return undefined;
  }
  return entry[0]?.slice(encodedName.length);
};

const hasCookie = (header: string | undefined, name: string) =>
  Boolean(
    header
      ?.split(";")
      .map((part) => part.trim())
      .some((part) => part.startsWith(`${name}=`)),
  );

const ipToBigInt = (
  address: string,
): { value: bigint; bits: number } | null => {
  const normalized = address.replace(/^::ffff:/i, "");
  const family = isIP(normalized);
  if (family === 4) {
    const value = normalized
      .split(".")
      .reduce((accumulator, part) => (accumulator << 8n) | BigInt(part), 0n);
    return { value, bits: 32 };
  }
  if (family !== 6) {
    return null;
  }

  const expanded = normalized.replace(
    /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
    (ipv4) => {
      const value = ipToBigInt(ipv4);
      if (!value) return ipv4;
      return `${((value.value >> 16n) & 0xffffn).toString(16)}:${(value.value & 0xffffn).toString(16)}`;
    },
  );
  const [left, right = ""] = expanded.toLowerCase().split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const groups = expanded.includes("::")
    ? [
        ...leftGroups,
        ...Array(8 - leftGroups.length - rightGroups.length).fill("0"),
        ...rightGroups,
      ]
    : leftGroups;
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[\da-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  const value = groups.reduce(
    (accumulator, group) => (accumulator << 16n) | BigInt(`0x${group}`),
    0n,
  );
  return { value, bits: 128 };
};

const addressMatches = (address: string, configured: string) => {
  const [networkAddress, prefixText] = configured.split("/");
  if (!networkAddress) return false;
  const addressValue = ipToBigInt(address);
  const networkValue = ipToBigInt(networkAddress);
  if (
    !addressValue ||
    !networkValue ||
    addressValue.bits !== networkValue.bits
  ) {
    return false;
  }
  const prefix =
    prefixText === undefined ? addressValue.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > addressValue.bits) {
    return false;
  }
  const shift = BigInt(addressValue.bits - prefix);
  return addressValue.value >> shift === networkValue.value >> shift;
};

const isTrustedProxy = (
  remoteAddress: string | undefined,
  trustedProxy: string,
) => {
  if (!remoteAddress || trustedProxy === "false") return false;
  if (trustedProxy === "true") return true;
  if (/^\d+$/.test(trustedProxy)) return Number(trustedProxy) > 0;
  return trustedProxy
    .split(",")
    .map((address) => address.trim())
    .some((address) => addressMatches(remoteAddress, address));
};

export const isSecureTransport = (
  socketEncrypted: boolean,
  forwardedProto?: string | string[],
  remoteAddress?: string,
  trustedProxy = "false",
) => {
  if (socketEncrypted) return true;
  if (!isTrustedProxy(remoteAddress, trustedProxy)) return false;
  const protocols = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto?.split(",");
  return Boolean(
    protocols?.length &&
    protocols.every((protocol) => protocol.trim().toLowerCase() === "https"),
  );
};

export function initializeSocket(server: HTTPServer, app: FastifyInstance) {
  if (io) {
    return io;
  }

  const sessions = new SessionService();
  io = new SocketIOServer(server, {
    cors: {
      origin: env.trustedWebOrigins,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      if (!(await allowSocketConnection(socket.request.socket.remoteAddress))) {
        return next(new Error("Too many connection attempts"));
      }

      if (
        env.NODE_ENV === "production" &&
        !isSecureTransport(
          Boolean((socket.request.socket as { encrypted?: boolean }).encrypted),
          socket.handshake.headers["x-forwarded-proto"],
          socket.request.socket.remoteAddress,
          env.TRUST_PROXY,
        )
      ) {
        return next(new Error("Secure transport required"));
      }

      const credentialFromCookie = cookieValue(
        socket.handshake.headers.cookie,
        SESSION_COOKIE_NAME,
      );
      const hasWebCookie = hasCookie(
        socket.handshake.headers.cookie,
        SESSION_COOKIE_NAME,
      );
      const nativeCredential = socket.handshake.auth?.token;
      if (
        (hasWebCookie && nativeCredential !== undefined) ||
        (!credentialFromCookie && typeof nativeCredential !== "string")
      ) {
        return next(new Error("Authentication required"));
      }

      const clientType = hasWebCookie ? "web" : "native";
      const credential = credentialFromCookie ?? nativeCredential;
      if (typeof credential !== "string" || credential.length === 0) {
        return next(new Error("Authentication required"));
      }

      if (clientType === "web") {
        if (
          !env.trustedWebOrigins.includes(
            socket.handshake.headers.origin ?? "",
          ) ||
          typeof socket.handshake.auth?.csrfToken !== "string"
        ) {
          return next(new Error("Authentication required"));
        }
      } else if (socket.handshake.headers.origin !== undefined) {
        return next(new Error("Authentication required"));
      }

      const session = await sessions.authenticate(credential, clientType);
      if (
        clientType === "web" &&
        !(await sessions.verifyCsrfToken(
          session,
          socket.handshake.auth?.csrfToken,
        ))
      ) {
        return next(new Error("Authentication required"));
      }
      if (session.role === "worker") {
        await sessions.authorizeWorker(session.userId);
      }

      const verifier = await sessions.verifierForCredential(credential);
      socket.data.user = { userId: session.userId, role: session.role };
      socket.data.appSession = {
        id: verifier.id,
        tokenHash: verifier.tokenHash,
        clientType,
      };
      next();
    } catch (error) {
      if (!(error instanceof AppSessionError)) {
        app.log.error("Socket authentication dependency failed");
      }
      next(new Error("Authentication required"));
    }
  });

  io.on("connection", (socket) => {
    registerWorkerSocket(socket);

    const revalidate = async () => {
      const sessionRef = socket.data.appSession as
        | { id: string; tokenHash: string; clientType: "web" | "native" }
        | undefined;
      if (!sessionRef) {
        socket.disconnect(true);
        return;
      }

      try {
        const session = await sessions.authenticateVerifier(
          sessionRef.id,
          sessionRef.tokenHash,
          sessionRef.clientType,
        );
        const currentUser = socket.data.user as
          | { userId: number; role: string }
          | undefined;
        if (
          !session ||
          !currentUser ||
          session.userId !== currentUser.userId ||
          session.role !== currentUser.role
        ) {
          socket.disconnect(true);
          return;
        }
        if (session.role === "worker") {
          await sessions.authorizeWorker(session.userId);
        }
        socket.data.user = { userId: session.userId, role: session.role };
      } catch (error) {
        if (!(error instanceof AppSessionError)) {
          app.log.error("Socket session revalidation dependency failed");
        }
        socket.disconnect(true);
      }
    };

    const revalidationTimer = setInterval(() => {
      void revalidate();
    }, SESSION_REVALIDATION_INTERVAL_MS);
    revalidationTimer.unref();
    socket.on("disconnect", () => clearInterval(revalidationTimer));

    socket.use((_packet, next) => {
      void revalidate()
        .then(() => {
          if (socket.connected) {
            next();
          } else {
            next(new Error("Authentication required"));
          }
        })
        .catch(() => {
          socket.disconnect(true);
          next(new Error("Authentication required"));
        });
    });
  });

  return io;
}

export function getSocketIO(): SocketIOServer {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initializeSocket first.");
  }
  return io;
}
