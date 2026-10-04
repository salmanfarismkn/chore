# Pronto+ Backend Release Audit

**Audit date:** 2026-10-04  
**Verdict:** **NO-GO for a public v1 release.** The exercised booking/allocation path now works, but material authorization, allocation recovery, and Redis/PostgreSQL consistency risks remain.

## Verified Capabilities

- Backend TypeScript compilation succeeds with `pnpm build`.
- The scoped Vitest suite passes 6 files and 75 tests, including booking lifecycle, sequential and concurrent idempotency, Redis winner locking, booking ownership checks, and one seeded allocation/assignment flow.
- Booking creation now invokes TEP allocation. The integration test seeds an eligible worker/service association and observes the booking move to `ALLOCATING` before accepting the offer.
- Concurrent duplicate booking requests return the same booking ID; the database constraint scopes idempotency keys by `(user_id, key)`.
- Redis winner acquisition uses `SET NX`; the concurrency test verifies exactly one winner. Offer acceptance also uses a Lua script to verify the offer identity, status, expiry, and winner claim.
- Booking list/detail/create and worker lifecycle routes now enforce authentication and ownership/role checks. Allocation offer creation is admin-only; acceptance derives worker identity from the JWT.
- Environment parsing validates the database URL, Redis URL, and minimum JWT secret length. `/ready` checks PostgreSQL and Redis in code; it was not separately probed over HTTP during this audit.
- Compose parses successfully with a temporary audit-only JWT value. No schema or migration was changed.

## Critical Findings

1. **User and worker endpoints expose and mutate protected data without authorization.** `GET /v1/users` returns user records; worker list/detail routes expose profile fields including coordinates, and worker profile create/update/delete routes have no authentication. These remain reachable regardless of the booking-route protections. Review [users.routes.ts](../backend/src/modules/users/users.routes.ts) and [workers.routes.ts](../backend/src/modules/workers/workers.routes.ts).

2. **There is no production authentication issuance flow.** The only route that mints JWTs is `/test-token`, now restricted to `NODE_ENV=test`; there is no production login/refresh or verified phone-auth flow. Public user creation is not credential verification. A real client cannot obtain a trustworthy production identity. See [auth.routes.ts](../backend/src/modules/auth/auth.routes.ts) and [env.ts](../backend/src/config/env.ts).

## High Findings

1. **Expired offers do not advance allocation or reliably fail the booking.** `AllocationExpirationWorker.processExpiredOffers()` is empty. The recovery worker is not started by [server.ts](../backend/src/server.ts), and recovery calls `BookingsRepository.getBooking` through `as any`, but that method does not exist. TEP can start a first tier, but expiry, later tiers, and recovery after process interruption are not operational. See [allocation-expiration.worker.ts](../backend/src/modules/allocation/allocation-expiration.worker.ts), [allocation-recovery.worker.ts](../backend/src/modules/allocation/allocation-recovery.worker.ts), [allocation-recovery.service.ts](../backend/src/modules/allocation/allocation-recovery.service.ts), and [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).

2. **Redis acceptance is not compensated when PostgreSQL assignment fails.** Acceptance marks the offer `accepted` and claims a Redis winner. On a database error, [allocation-assignment.service.ts](../backend/src/modules/allocation/allocation-assignment.service.ts) only releases the winner lock; it does not restore or expire the offer state. A retry then cannot accept that offer. Winner keys have no TTL, so a process crash between Redis and PostgreSQL can also leave stale state. There is no failure-injection or simultaneous HTTP-acceptance test.

3. **The production booking lifecycle enum does not match the domain state machine.** [booking-status.ts](../backend/src/modules/bookings/booking-status.ts) includes `ACCEPTED` and `ALLOCATION_FAILED`; [enums.ts](../backend/src/db/schema/enums.ts) and migrations do not include those values. The `/accept` transition therefore is not portable to a database created strictly from the committed migrations; allocation failure is instead represented as cancellation. Verify and reconcile this contract before release. No migration was changed in this audit.

4. **Worker ranking does not use distance.** [allocation.service.ts](../backend/src/modules/allocation/allocation.service.ts) computes `distanceKm`, but `computeScore` uses only rating and completed-job count and sorting uses that score. The separately tested distance-ranking utility is not used by this service. The “nearby worker” behavior is therefore not evidenced by the active allocation path.

5. **Compose still uses development database credentials and publishes database/admin services.** The JWT fallback was removed so missing `JWT_SECRET` now fails closed, but the Compose definition still configures a fixed PostgreSQL password, maps PostgreSQL and pgAdmin ports, and uses default pgAdmin credentials. Do not use this stack as a public production deployment without replacing those settings and restricting access. See [docker-compose.yml](../infrastructure/docker/docker-compose.yml).

## Medium Findings

- Booking rows have no database foreign keys to users, worker profiles, or service categories, so direct database writes/deletes can create orphaned records. Existing indexes cover common booking lookups; the idempotency unique constraint is present. See [bookings.ts](../backend/src/db/schema/bookings.ts) and migration `0000`.
- Graceful shutdown closes Fastify, Socket.IO, and Redis, but the Postgres client is not closed. The backend Compose service has no container healthcheck even though `/ready` exists. See [server.ts](../backend/src/server.ts), [db/index.ts](../backend/src/db/index.ts), and [docker-compose.yml](../infrastructure/docker/docker-compose.yml).
- Socket authentication verifies JWT signatures and only worker claims join worker rooms, but there are no focused socket authentication, reconnect, stale-presence, or multi-connection disconnect tests. Redis presence keys have no expiry/reconciliation path.
- The k6 script uses fixed user/customer/service IDs and has no fixture setup for them. It was not run; there are no load/evaluation result files, so no performance claim is made. See [allocation.js](../backend/tests/load/allocation.js).
- No CI workflow files or production auth/security integration suite were found. The six source test files do not cover offer expiry/tier progression, recovery after interruption, Redis-success/DB-failure compensation, cross-user idempotency semantics, inactive-user JWT revocation, or worker socket presence lifecycle.

## Prioritized Required Fixes

1. Add production authentication and authorize user/worker CRUD and reads; validate active users and roles from trusted server-side records.
2. Complete and start the allocation expiry/recovery workers; remove the `any` repository call and test tier exhaustion and crash recovery.
3. Make Redis acceptance and PostgreSQL assignment recoverable as one workflow: bounded winner leases, safe compensation/reconciliation, and tests for concurrent HTTP acceptance and database failure.
4. Use distance in the active ranking algorithm and test the actual TEP ranking/tier behavior.
5. Reconcile the domain booking states with committed migrations; add referential constraints only after confirming the intended delete semantics.
6. Separate local Compose defaults from production deployment configuration; require unique database/admin secrets, avoid public database/admin port exposure, and add a backend healthcheck.
7. Add CI gates and provisioned, repeatable k6 fixtures; record load results before making performance claims.

## Commands and Results

| Command | Result |
| --- | --- |
| `pnpm build` (from `backend`) | PASS; TypeScript compilation completed. |
| `pnpm exec vitest run` (from `backend`, final scoped run) | PASS; 6 files, 75 tests. |
| `pnpm exec vitest run src/modules/allocation/allocation-concurrency.test.ts` | PASS; 1 file, 3 tests, after replacing database-wide Redis flush with targeted test-key cleanup. |
| `pnpm exec turbo run check-types --ui=stream` | PASS; 3 tasks (UI, docs, web). Backend has no `check-types` script, so backend type-check evidence is `pnpm build`. |
| `docker compose config -q` | PASS with a temporary non-production JWT value; syntax validation only, no containers started. |
| k6 load test | NOT RUN; no performance result available. |
| `pnpm test -- --run` | Not usable here; pnpm rejected the forwarded `run` option. The direct Vitest command was used instead. |

**Redis data-safety disclosure:** An earlier full-suite run executed the original `allocation-concurrency.test.ts`, whose setup called `redis.flushDb()`. Because Vitest loaded the test environment, that command cleared all keys in the selected Redis database, not only test keys. I did not attempt restoration; existing keys in that database may have been lost. The test has since been changed to delete only its own unique winner keys, and the final suite run did not perform a database-wide flush.

## Changes Made During Audit

- Restricted test JWT minting to test mode; added booking owner/role checks and allocation endpoint authorization.
- Wired booking creation into TEP and corrected worker candidate joins to use the worker user ID expected by the worker-service foreign key.
- Re-read the winning idempotency response after concurrent insert conflict; added a database-backed concurrent duplicate test.
- Corrected worker presence updates to target profiles by user ID.
- Scoped Vitest to backend source tests, made integration fixture IDs collision-resistant, and replaced Redis `FLUSHDB` test cleanup with per-test key deletion.
- Removed the predictable JWT secret fallback from the existing Compose edit without altering the other pre-existing Compose changes.