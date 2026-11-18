import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { eq, inArray } from "drizzle-orm";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectRedis, redis } from "../config/redis";
import { db } from "../db";
import {
  bookings,
  serviceCategories,
  users,
  workerProfiles,
} from "../db/schema";
import { AllocationAcceptanceService } from "../modules/allocation/allocation-acceptance.service";

const enabled = process.env.A101_MULTI_PROCESS_TEST === "1";
const backendDirectory = process.cwd();
const validationNetwork = "pronto-a101-validation-net";
const postgresContainer = "pronto-a101-validation-postgres";
const redisContainer = "pronto-a101-validation-redis";
const postgresVolume = "pronto-a101-validation-pgdata";
const redisVolume = "pronto-a101-validation-redisdata";

interface BackendProcess {
  child: ChildProcess;
  port: number;
  logs: string;
}

const assertDisposableEndpoints = () => {
  const database = new URL(process.env.DATABASE_URL ?? "");
  const redisUrl = new URL(process.env.REDIS_URL ?? "");
  if (
    database.hostname !== "127.0.0.1" ||
    database.port !== "25496" ||
    database.pathname !== "/pronto_a101" ||
    redisUrl.hostname !== "127.0.0.1" ||
    redisUrl.port !== "26396"
  ) {
    throw new Error("Multi-process test requires the isolated A101 endpoints");
  }
};

const inspectDisposableContainers = () => {
  const inspect = (name: string) =>
    JSON.parse(
      execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
    )[0] as {
      Id: string;
      State: { Status: string };
      NetworkSettings: { Networks: Record<string, unknown> };
      Mounts: { Name: string; Destination: string }[];
    };
  const pg = inspect(postgresContainer);
  const cache = inspect(redisContainer);
  for (const [container, volume, destination] of [
    [pg, postgresVolume, "/var/lib/postgresql/data"],
    [cache, redisVolume, "/data"],
  ] as const) {
    if (
      container.State.Status !== "running" ||
      Object.keys(container.NetworkSettings.Networks).join() !==
        validationNetwork ||
      !container.Mounts.some(
        (mount) => mount.Name === volume && mount.Destination === destination,
      )
    ) {
      throw new Error("A101 container isolation could not be verified");
    }
  }
  return { postgresId: pg.Id, redisId: cache.Id };
};

const dockerRedis = (...args: string[]) => {
  const redisPassword = decodeURIComponent(
    new URL(process.env.REDIS_URL!).password,
  );
  return execFileSync(
    "docker",
    [
      "exec",
      redisContainer,
      "redis-cli",
      "--no-auth-warning",
      "-a",
      redisPassword,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
};

const dockerExecPostgres = (...args: string[]) =>
  execFileSync("docker", ["exec", postgresContainer, ...args], {
    encoding: "utf8",
  }).trim();

const disconnectContainerNetwork = (name: string) => {
  inspectDisposableContainers();
  execFileSync("docker", ["network", "disconnect", validationNetwork, name]);
};

const reconnectContainerNetwork = (name: string) => {
  execFileSync("docker", ["network", "connect", validationNetwork, name]);
};

const request = async (url: string, init?: RequestInit) => {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(11_000),
    });
    return {
      response,
      durationMs: performance.now() - startedAt,
      body: await response.text(),
    };
  } catch (error) {
    throw new Error(`Dependency probe exceeded 11 seconds: ${url}`, {
      cause: error,
    });
  }
};

const reservePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
};

const startBackend = async (port: number): Promise<BackendProcess> => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/start.ts"], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      SKIP_TEST_DB_SETUP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processState: BackendProcess = { child, port, logs: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      processState.logs = `${processState.logs}${chunk.toString()}`.slice(
        -8_000,
      );
    });
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Backend on port ${port} exited early:\n${processState.logs}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        return processState;
      }
    } catch {
      await delay(100);
    }
  }
  throw new Error(
    `Backend on port ${port} did not become ready:\n${processState.logs}`,
  );
};

const stopBackend = async (backend: BackendProcess) => {
  if (backend.child.exitCode !== null) {
    return;
  }
  backend.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => backend.child.once("exit", () => resolve())),
    delay(10_000).then(() => {
      throw new Error(
        `Backend on port ${backend.port} did not stop gracefully`,
      );
    }),
  ]);
};

const connectWorker = (url: string, token: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = createSocketClient(url, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 5_000,
    });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Worker socket connection timed out"));
    }, 7_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
  });

const waitFor = async (
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for integration state");
};

describe.skipIf(!enabled)("Socket.IO multi-instance delivery", () => {
  const backends: BackendProcess[] = [];
  const sockets: Socket[] = [];
  const userIds: number[] = [];
  let bookingId = 0;
  let serviceCategoryId = 0;
  let workerId = 0;
  let unrelatedWorkerId = 0;
  let adminToken = "";
  let workerToken = "";
  let unrelatedWorkerToken = "";

  beforeAll(async () => {
    assertDisposableEndpoints();
    inspectDisposableContainers();
    await connectRedis();

    const ports = await Promise.all([reservePort(), reservePort()]);
    backends.push(await startBackend(ports[0]), await startBackend(ports[1]));

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const [admin, customer, worker, unrelatedWorker] = await db
      .insert(users)
      .values([
        {
          phoneNumber: `+1551${suffix}01`,
          fullName: "A101 administrator",
          role: "admin",
        },
        {
          phoneNumber: `+1551${suffix}02`,
          fullName: "A101 customer",
          role: "customer",
        },
        {
          phoneNumber: `+1551${suffix}03`,
          fullName: "A101 worker",
          role: "worker",
        },
        {
          phoneNumber: `+1551${suffix}04`,
          fullName: "A101 unrelated worker",
          role: "worker",
        },
      ])
      .returning({ id: users.id });
    userIds.push(admin.id, customer.id, worker.id, unrelatedWorker.id);
    workerId = worker.id;
    unrelatedWorkerId = unrelatedWorker.id;

    await db.insert(workerProfiles).values([
      {
        userId: workerId,
        status: "available",
        approvalStatus: "approved",
        approvalDecidedAt: new Date(),
      },
      {
        userId: unrelatedWorkerId,
        status: "available",
        approvalStatus: "approved",
        approvalDecidedAt: new Date(),
      },
    ]);

    const [service] = await db
      .insert(serviceCategories)
      .values({
        name: `A101 service ${suffix}`,
        description: "Isolated multi-instance socket test",
        basePrice: "50.00",
        estimatedDurationMinutes: 30,
      })
      .returning({ id: serviceCategories.id });
    serviceCategoryId = service.id;

    const [booking] = await db
      .insert(bookings)
      .values({
        customerId: customer.id,
        serviceCategoryId,
        status: "ALLOCATING",
        allocationGeneration: 1,
        scheduledAt: new Date(),
        pickupLatitude: 23.2599,
        pickupLongitude: 77.4126,
        estimatedPrice: "50.00",
      })
      .returning({ id: bookings.id });
    bookingId = booking.id;

    const baseUrl = `http://127.0.0.1:${backends[0].port}`;
    const issueToken = async (userId: number, role: "admin" | "worker") => {
      const response = await fetch(`${baseUrl}/v1/auth/test-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      if (!response.ok) {
        throw new Error(`Test session creation failed with ${response.status}`);
      }
      return ((await response.json()) as { token: string }).token;
    };
    [adminToken, workerToken, unrelatedWorkerToken] = await Promise.all([
      issueToken(admin.id, "admin"),
      issueToken(workerId, "worker"),
      issueToken(unrelatedWorkerId, "worker"),
    ]);
  }, 60_000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.close());
    await Promise.all(backends.map(stopBackend));

    if (bookingId && workerId) {
      const offerKey = `booking:${bookingId}:offer:${workerId}`;
      await Promise.all([
        redis.del(offerKey),
        redis.del(`worker:${workerId}:connections`),
        redis.sRem("allocation:offers:pending", offerKey),
        redis.sRem(`worker:${workerId}:offers:pending`, offerKey),
        redis.sRem(`booking:${bookingId}:allocation:offers`, offerKey),
      ]);
      await db.delete(bookings).where(eq(bookings.id, bookingId));
    }
    if (userIds.length) {
      await db
        .delete(workerProfiles)
        .where(inArray(workerProfiles.userId, userIds));
      await db
        .delete(serviceCategories)
        .where(eq(serviceCategories.id, serviceCategoryId));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, 30_000);

  it("delivers offers across replicas only to authenticated worker rooms and recovers connection state", async () => {
    const replicaB = `http://127.0.0.1:${backends[1].port}`;
    const workerSockets = await Promise.all([
      connectWorker(replicaB, workerToken),
      connectWorker(replicaB, workerToken),
    ]);
    const unrelatedSocket = await connectWorker(replicaB, unrelatedWorkerToken);
    sockets.push(...workerSockets, unrelatedSocket);

    const counts = new Map<Socket, number>();
    const received = new Map<Socket, unknown>();
    for (const socket of workerSockets) {
      counts.set(socket, 0);
      socket.on("booking:offer", (event: unknown) => {
        counts.set(socket, (counts.get(socket) ?? 0) + 1);
        received.set(socket, event);
      });
    }
    let unrelatedCount = 0;
    unrelatedSocket.on("booking:offer", () => {
      unrelatedCount += 1;
    });

    expect(
      dockerRedis("CLIENT", "LIST", "TYPE", "pubsub").split("\n"),
    ).toHaveLength(2);
    expect(Number(dockerRedis("CLIENT", "KILL", "TYPE", "pubsub"))).toBe(2);
    await waitFor(async () => {
      const [first, second] = await Promise.all([
        fetch(`http://127.0.0.1:${backends[0].port}/ready`),
        fetch(`http://127.0.0.1:${backends[1].port}/ready`),
      ]);
      return first.status === 200 && second.status === 200;
    }, 15_000);

    const createOffer = async () => {
      const response = await fetch(
        `http://127.0.0.1:${backends[0].port}/v1/allocation/bookings/${bookingId}/offer`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            workerId,
            tier: "tier_1",
            ttlSeconds: 120,
          }),
        },
      );
      expect(response.status).toBe(201);
      return response.json();
    };

    const deliveryStartedAt = performance.now();
    await createOffer();
    await waitFor(async () =>
      workerSockets.every((socket) => counts.get(socket) === 1),
    );
    console.info(
      `A101 cross-replica delivery: ${(
        performance.now() - deliveryStartedAt
      ).toFixed(1)}ms`,
    );
    for (const event of received.values()) {
      expect(event).toMatchObject({
        bookingId,
        workerId,
        generation: 1,
      });
    }
    await delay(250);
    expect(unrelatedCount).toBe(0);

    workerSockets[0].close();
    await waitFor(
      async () => (await redis.sCard(`worker:${workerId}:connections`)) === 1,
    );
    const reconnectedSocket = await connectWorker(replicaB, workerToken);
    sockets.push(reconnectedSocket);
    await waitFor(
      async () => (await redis.sCard(`worker:${workerId}:connections`)) === 2,
    );

    workerSockets[1].close();
    reconnectedSocket.close();
    await waitFor(
      async () => (await redis.sCard(`worker:${workerId}:connections`)) === 0,
    );
    await waitFor(
      async () =>
        (await redis.hGet(
          `booking:${bookingId}:offer:${workerId}`,
          "status",
        )) === "rejected",
    );
    await expect(
      new AllocationAcceptanceService().accept(bookingId, workerId, 1),
    ).resolves.toBe(false);

    const recoveredSocket = await connectWorker(replicaB, workerToken);
    sockets.push(recoveredSocket);
    await waitFor(
      async () => (await redis.sCard(`worker:${workerId}:connections`)) === 1,
    );
    recoveredSocket.close();
    await waitFor(
      async () => (await redis.sCard(`worker:${workerId}:connections`)) === 0,
    );
  }, 60_000);

  it("bounds dependency failures and recovers readiness and protected requests", async () => {
    const baseUrl = `http://127.0.0.1:${backends[0].port}`;
    const userUrl = `${baseUrl}/v1/users`;
    const authorization = { authorization: `Bearer ${adminToken}` };
    const containers = inspectDisposableContainers();
    expect(containers.postgresId).toMatch(/^[a-f\d]{64}$/);
    expect(containers.redisId).toMatch(/^[a-f\d]{64}$/);

    disconnectContainerNetwork(postgresContainer);
    let postgresReadiness: Awaited<ReturnType<typeof request>>;
    let postgresProtected: Awaited<ReturnType<typeof request>>;
    try {
      postgresReadiness = await request(`${baseUrl}/ready`);
      postgresProtected = await request(userUrl, { headers: authorization });
    } finally {
      reconnectContainerNetwork(postgresContainer);
    }
    expect(postgresReadiness.response.status).toBe(503);
    expect(postgresReadiness.durationMs).toBeLessThan(10_000);
    expect(postgresProtected.response.status).toBe(503);
    expect(postgresProtected.durationMs).toBeLessThan(10_000);
    expect(postgresProtected.body).not.toContain("127.0.0.1");

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/ready`);
      return response.status === 200;
    }, 15_000);
    const recoveredDatabaseRequest = await request(userUrl, {
      headers: authorization,
    });
    expect(recoveredDatabaseRequest.response.status).toBe(200);
    const leakedDatabaseWork = dockerExecPostgres(
      "psql",
      "-U",
      "a101_test",
      "-d",
      "pronto_a101",
      "-Atc",
      "select count(*) from pg_stat_activity where application_name = 'pronto-backend' and state in ('active', 'idle in transaction')",
    );
    expect(Number(leakedDatabaseWork)).toBe(0);

    disconnectContainerNetwork(redisContainer);
    let redisReadiness: Awaited<ReturnType<typeof request>>;
    let redisProtected: Awaited<ReturnType<typeof request>>;
    try {
      redisReadiness = await request(`${baseUrl}/ready`);
      redisProtected = await request(userUrl, { headers: authorization });
    } finally {
      reconnectContainerNetwork(redisContainer);
    }
    expect(redisReadiness.response.status).toBe(503);
    expect(redisReadiness.durationMs).toBeLessThan(4_500);
    expect(redisProtected.response.status).toBe(503);
    expect(redisProtected.durationMs).toBeLessThan(4_500);
    expect(redisProtected.body).not.toContain("127.0.0.1");
    console.info(
      `A101 PostgreSQL partition: readiness=${postgresReadiness.durationMs.toFixed(1)}ms, protected=${postgresProtected.durationMs.toFixed(1)}ms; Redis partition: readiness=${redisReadiness.durationMs.toFixed(1)}ms, protected=${redisProtected.durationMs.toFixed(1)}ms`,
    );

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/ready`);
      return response.status === 200;
    }, 15_000);
    await waitFor(async () => redis.isReady, 15_000);
    const recoveredRedisRequest = await request(userUrl, {
      headers: authorization,
    });
    expect(recoveredRedisRequest.response.status).toBe(200);
  }, 60_000);
});
