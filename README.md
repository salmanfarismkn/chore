# Chore

Chore is a worker-based chore booking backend. It accepts customer bookings, identifies available workers associated with a service, and coordinates booking assignment. The project focuses on transactional booking creation, idempotency, worker eligibility, allocation coordination, and lifecycle state.

This pnpm/Turborepo workspace also contains `apps/web` and `apps/docs`; this README documents the backend in `backend/`.

## Implemented

- Fastify REST API with Zod validation, JWT verification, CORS, Helmet, Swagger UI, and health/readiness routes.
- PostgreSQL persistence through Drizzle ORM and committed migrations.
- Booking creation with service-price lookup and user-scoped `Idempotency-Key` handling, including concurrent duplicate requests.
- First-pass worker allocation using active worker-service links and available worker profiles; Redis offer/winner state and Socket.IO offer delivery.
- Conditional PostgreSQL assignment and booking lifecycle transition checks.
- Worker Socket.IO JWT verification, worker-room membership, and presence/availability updates.

These describe code paths, not production certification. Current gaps are listed under [Limitations](#limitations) and the [final release-readiness review](docs/FINAL_RELEASE_READINESS.md).

## Architecture

```mermaid
flowchart LR
    Client[Customer or worker client] -->|HTTP / Socket.IO| API[Fastify API]
    API --> Auth[JWT verification]
    API --> Booking[Booking routes and service]
    Booking -->|booking and idempotency transaction| PG[(PostgreSQL)]
    Booking --> TEP[First-pass allocation]
    TEP -->|eligible worker/service query| PG
    TEP --> Redis[(Redis offers and winner claims)]
    Redis -->|booking:offer| Socket[Socket.IO]
    Socket --> Worker[Worker client]
    Worker -->|authenticated acceptance| API
    API -->|conditional assignment| PG
    API --> Health[/health and /ready]
```

The TypeScript state map is:

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> ALLOCATING
    PENDING --> CANCELLED
    ALLOCATING --> ASSIGNED
    ALLOCATING --> ALLOCATION_FAILED
    ALLOCATING --> CANCELLED
    ASSIGNED --> ACCEPTED
    ASSIGNED --> CANCELLED
    ACCEPTED --> EN_ROUTE
    ACCEPTED --> CANCELLED
    EN_ROUTE --> WORKING
    EN_ROUTE --> CANCELLED
    WORKING --> COMPLETED
    WORKING --> CANCELLED
```

This diagram matches the current persisted enum, including `ACCEPTED` and `ALLOCATION_FAILED`, after migrations 0009, 0010, and 0011.

## Technology and Repository

| Area                  | Technology                                    |
| --------------------- | --------------------------------------------- |
| Runtime/API           | Node.js, TypeScript, Fastify 5                |
| Validation/auth       | Zod, `@fastify/jwt`, JWT                      |
| Persistence           | PostgreSQL 16, Drizzle ORM, `postgres` client |
| Coordination/realtime | Redis 7, Socket.IO                            |
| Tests/load            | Vitest, k6                                    |
| Workspace             | pnpm 9, Turborepo                             |

```text
backend/                 Fastify API, migrations, tests, k6 scenario
infrastructure/docker/   Development and production Compose configurations
apps/web/                Web workspace app
apps/docs/               Docs workspace app
packages/                Shared UI, ESLint, and TypeScript configuration
docs/                    Release audit and validation evidence
```

## Prerequisites

- Node.js 18 or newer (the Docker image uses Node.js 22).
- Corepack and pnpm 9.0.0, as declared by the root `package.json`.
- Docker Desktop with Docker Compose for local PostgreSQL and Redis.
- k6 only if running the load scenario.

## Local Setup (PowerShell)

From the repository root:

```powershell
corepack enable
corepack prepare pnpm@9.0.0 --activate
pnpm install
Copy-Item backend/.env.example backend/.env
```

Edit `backend/.env`: replace the database URL with a valid local PostgreSQL URL and set `JWT_SECRET` to a random value of at least 32 characters. Keep `.env` local; it is ignored by Git. The default Compose file is development-only and includes local database, Redis, and pgAdmin port mappings.

Start local PostgreSQL and Redis. Compose interpolation requires `JWT_SECRET`, so provide the completed backend environment file:

```powershell
docker compose --env-file backend/.env -f infrastructure/docker/docker-compose.yml up -d postgres redis
```

Apply migrations and run the backend:

```powershell
Set-Location backend
pnpm db:migrate
pnpm dev
```

The API defaults to port `3000` and binds to `0.0.0.0`. `pnpm dev` runs `tsx watch src/server.ts`; `pnpm start` runs compiled `dist/server.js` and requires `pnpm build` first. The Docker entrypoint uses `src/start.ts`, which runs migrations before importing the server.

Stop the API with `Ctrl+C`. Stop the local data services without removing their named volumes:

```powershell
docker compose --env-file backend/.env -f infrastructure/docker/docker-compose.yml stop postgres redis
```

## Environment Variables

The runtime validates these values in `backend/src/config/env.ts`:

| Variable         | Required/default                | Purpose                                                                         |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `NODE_ENV`       | `development`                   | `development`, `test`, or `production`; test-token route exists only in `test`. |
| `PORT`           | `3000`                          | HTTP listen port, integer from 1 to 65535.                                      |
| `DATABASE_URL`   | Required                        | PostgreSQL connection URL.                                                      |
| `REDIS_URL`      | `redis://localhost:6379`        | Redis URL.                                                                      |
| `JWT_SECRET`     | Required; minimum 32 characters | JWT signing and verification secret.                                            |
| `JWT_EXPIRES_IN` | `15m`                           | JWT expiration passed to `@fastify/jwt`.                                        |
| `CORS_ORIGIN`    | `http://localhost:5173`         | Origin allowed by HTTP CORS and Socket.IO.                                      |
| `TRUST_PROXY`    | `false`                          | Fastify proxy trust: `false`, `true`, hop count, or an explicit proxy address list. |
| `RATE_LIMIT_AUTH_MAX` | `10` | Maximum test-token authentication attempts per client in the configured window. |
| `RATE_LIMIT_AUTH_WINDOW_MS` | `60000` | Authentication rate-limit window in milliseconds. |
| `RATE_LIMIT_BOOKING_MAX` | `20` | Maximum booking creations per client in the configured window. |
| `RATE_LIMIT_BOOKING_WINDOW_MS` | `60000` | Booking rate-limit window in milliseconds. |
| `RATE_LIMIT_ACCEPTANCE_MAX` | `30` | Maximum allocation accept attempts per client in the configured window. |
| `RATE_LIMIT_ACCEPTANCE_WINDOW_MS` | `60000` | Allocation acceptance rate-limit window in milliseconds. |

`HOST`, `CLIENT_URL`, and `SOCKET_CORS` are not read by the current runtime. `.env.example` contains placeholders only; replace them locally.

## Production Compose configuration

Production must use [docker-compose.production.yml](infrastructure/docker/docker-compose.production.yml),
not the development Compose file:

```powershell
Copy-Item infrastructure/docker/.env.production.example infrastructure/docker/.env.production
# Edit the copied file with values supplied by the deployment secret manager.
docker compose --env-file infrastructure/docker/.env.production -f infrastructure/docker/docker-compose.production.yml config
docker compose --env-file infrastructure/docker/.env.production -f infrastructure/docker/docker-compose.production.yml up -d --build
```

Production requires `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`DATABASE_URL`, `REDIS_PASSWORD`, `REDIS_URL`, `JWT_SECRET`, and
`CORS_ORIGIN`. `JWT_SECRET` must be at least 32 characters and production
validation rejects known development placeholders and local database/Redis
endpoints. `TRUST_PROXY` must match the actual trusted proxy topology.

The production file keeps PostgreSQL and Redis on the internal Compose network,
does not include pgAdmin, and publishes only the backend port. The development
file remains the place for local PostgreSQL/Redis/pgAdmin port mappings.
Compose environment files are an operator convenience, not production-grade
secret management; use an external secret manager and private network policy
for deployment. The backend entrypoint still runs Drizzle migrations before
starting the server. Do not use `drizzle-kit push` for production migrations.

## API and Authentication

With the default port, Swagger UI is at `http://localhost:3000/docs`. OpenAPI server metadata points to `http://localhost:3000`.

| Route                                                                       | Authentication and behavior                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /health`                                                               | Liveness; does not check dependencies.                                                                 |
| `GET /ready`                                                                | PostgreSQL `SELECT 1` and Redis `PING`; returns `503` if either is unavailable.                        |
| `POST /v1/auth/test-token`                                                  | Test mode only. Signs caller-supplied `userId` and role; never expose in production.                   |
| `POST /v1/bookings`                                                         | Customer JWT, matching `customerId`, and required `Idempotency-Key`; starts the first allocation pass. |
| `GET /v1/bookings/:id`                                                      | Authenticated booking owner, assigned worker, or admin.                                                |
| `GET /v1/bookings/customer/:customerId`                                     | Matching customer or admin.                                                                            |
| `GET /v1/bookings/worker/:workerId`                                         | Matching worker or admin.                                                                              |
| `POST /v1/bookings/:id/cancel`                                              | Authenticated; service checks customer/worker ownership and transition.                                |
| `POST /v1/bookings/:id/accept`, `/en-route`, `/start`, `/complete`          | Assigned worker JWT. `ACCEPTED` cannot persist on a fresh migrated database.                           |
| `POST /v1/allocation/bookings/:bookingId/offer`                             | Admin JWT; body uses `userId` or `workerId`, `tier`, `ttlSeconds`.                                     |
| `POST /v1/allocation/bookings/:bookingId/accept`                            | Worker JWT; worker identity comes from the token.                                                      |
| `/v1/users`, `/v1/workers`, `/v1/service-categories`, `/v1/worker-services` | Authenticated CRUD/catalog routes with role/ownership checks as implemented. |

There is no production login/refresh flow. The test-token route is not production authentication. User and worker CRUD/read routes must not be exposed to untrusted clients as currently configured.

### Booking Request Example

Use an existing customer and service-category ID. The test token endpoint is available only when running with `NODE_ENV=test`:

```powershell
$token = (Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3000/v1/auth/test-token" `
  -ContentType "application/json" `
  -Body '{"userId":1,"role":"customer"}').token

$headers = @{
  Authorization = "Bearer $token"
  "Idempotency-Key" = "booking-example-001"
}
$body = @{
  customerId = 1
  serviceCategoryId = 1
  scheduledAt = "2026-10-05T10:00:00.000Z"
  pickupLatitude = 23.2599
  pickupLongitude = 77.4126
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3000/v1/bookings" `
  -Headers $headers -ContentType "application/json" -Body $body
```

The request schema accepts `customerId`, `serviceCategoryId`, optional `scheduledAt`, `pickupLatitude`, and `pickupLongitude`. The service calculates `estimatedPrice` from the service base price. A new request returns `201`; a sequential replay found before creation returns the stored response with `200`. Concurrent duplicates return the same booking ID, although both race responses may be `201`.

## Booking and Allocation Behavior

Booking creation verifies the customer and service, stores the booking/idempotency response in one PostgreSQL transaction, then calls TEP. Candidate lookup requires an active worker-service link, an `available` profile, and coordinates. Ranking uses rating and completed-job count; distance is calculated but is not included in the score. Allocation generations, lease fencing, durable reconciliation, terminal cleanup, and worker-disconnect revocation are documented in the allocation reliability audit.

Configured tiers are 3 candidates/20 seconds, 5/20 seconds, then 10/30 seconds. The request path starts the first available tier; expiry and recovery workers progress or fail allocation under generation/lease fencing. Redis cleanup is retryable through the durable reconciliation marker.

Redis acceptance verifies offer identity, generation, pending status, and expiry before atomically claiming a winner. PostgreSQL assignment is conditional on `ALLOCATING` and the current generation. Assignment failure is compensated when safe; committed PostgreSQL assignment is not undone when Redis cleanup fails. Cross-store atomicity is not claimed.

## Tests and Load

Run from `backend`:

```powershell
pnpm build
pnpm exec vitest run
pnpm exec vitest run src/modules/allocation/allocation-concurrency.test.ts
pnpm exec vitest run src/modules/bookings/bookings.integration.test.ts src/modules/allocation/allocation.integration.test.ts
```

The Vitest setup connects to PostgreSQL for every test file and Redis for allocation concurrency/integration paths. If fewer than five expected tables exist, it runs `drizzle-kit push --force`; use an isolated disposable test database, not a shared or valuable database. Explicit environment URLs override `.env.test`.

The k6 scenario is fixed at 10 VUs for 30 seconds. Seed valid test-mode customer/service IDs first:

```powershell
k6 run -e BASE_URL=http://localhost:3000/v1 -e CUSTOMER_ID=1 -e SERVICE_CATEGORY_ID=1 backend/tests/load/allocation.js
```

Replace IDs with existing fixtures. It posts bookings and checks response IDs; it does not test offer acceptance or expiry.

### Local Evaluation

The isolated run in [VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md) completed 291 booking iterations and 292 HTTP requests in 30 seconds at a maximum of 10 VUs: 9.41 requests/s, 0% failed requests, p50 41.87 ms, and p95 60.88 ms. This small local first-allocation-path measurement is not a production benchmark or scalability claim.

## Limitations and Security

- No production login/refresh or verified identity flow exists. Test JWT minting is test-only.
- No production login/refresh or verified identity flow exists. Test JWT minting is test-only.
- Rate limiting is process-local and is not a shared multi-replica control.
- Crash-at-boundary, Redis/PostgreSQL failover, and deployment-scale behavior remain unverified.
- Ranking does not use distance.
- Socket.IO presence and stale-disconnect handling are implemented and isolated live-tested, but production-scale reconnect behavior remains unverified.
- Compose contains development-only database/admin defaults and publishes service ports. Do not deploy it publicly without replacing credentials, restricting network access, and verifying container health.
- The validation report recorded a restarting Compose backend despite point-in-time health probes; isolated API and load results are not deployment certification.

Priorities for future work are production authentication, distributed rate limiting, deterministic crash/failover testing, deployment-safe secrets/networking, and repeatable CI/load fixtures. See [FINAL_RELEASE_READINESS.md](docs/FINAL_RELEASE_READINESS.md).
