# Chore Backend v1 Validation Report

**Date:** 2026-10-04  
**Result:** Automated compilation and the isolated test suite pass. **Not release-ready:** migrated booking status cannot represent `ACCEPTED`; no-worker allocation stays `ALLOCATING`; offer-expiry progression/recovery is not implemented or started; user/worker APIs still have authorization gaps documented in [RELEASE_AUDIT.md](RELEASE_AUDIT.md).

## Environment and Safety

- Windows workspace, pnpm monorepo; backend TypeScript check is `pnpm build`.
- Validation used disposable PostgreSQL 16 and Redis 7 containers on ports `55432` and `56379`, started with `--rm` and no mounted volumes. Committed migrations were applied to this fresh database. Synthetic users/services were seeded there only.
- Vitest was run with explicit `DATABASE_URL`, `REDIS_URL`, and a validation-only JWT secret. The test config now respects explicit environment values rather than overriding them with `.env.test`.
- The app ran in test mode on port `3300`. k6 used the seeded customer, service, and eligible worker.
- `vitest.setup.ts` connects to PostgreSQL for every Vitest file. If fewer than five expected tables exist, it runs `drizzle-kit push --force`; this validation migrated the disposable database first, so that fallback was not invoked. Redis is required by allocation concurrency and booking/allocation integration paths.
- No existing database volumes or shared Redis keys were touched during this validation. The prior audit's Redis `FLUSHDB` disclosure remains applicable to that earlier run; the concurrency test now deletes only its own unique keys.

## Automated Checks

| Command                                                                                  | Result                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm build` (from `backend`)                                                            | PASS, exit 0. Backend TypeScript compilation.                                                                   |
| `pnpm exec turbo run check-types --ui=stream`                                            | PASS, exit 0; 3 tasks (UI, docs, web). Backend is not a Turbo `check-types` task; use `pnpm build` for it.      |
| `pnpm db:migrate` (isolated PostgreSQL)                                                  | PASS, exit 0; committed migration chain applied to a fresh database.                                            |
| `pnpm exec vitest run` (isolated PostgreSQL and Redis)                                   | PASS, exit 0; 6 files, 78 passed, 0 failed, 0 skipped.                                                          |
| `pnpm exec vitest run src/modules/allocation/distance.util.test.ts`                      | PASS, exit 0; 1 file, 3 passed.                                                                                 |
| `pnpm exec vitest run src/modules/allocation/allocation-concurrency.test.ts` (final run) | PASS, exit 0; 1 file, 6 passed.                                                                                 |
| Docker Postgres `pg_isready`; Redis `PING`                                               | PASS, exit 0 for both isolated services.                                                                        |
| `docker compose config -q`                                                               | PASS, exit 0 with a temporary validation-only JWT placeholder; configuration only, no Compose services started. |

The acceptance rollback test initially failed reproducibly: a simulated database rejection cleared the winner lock but left the offer `accepted`. After the rollback fix, the focused concurrency file passed all six cases.

## Allocation and API Scenarios

| Scenario                                                                                 | Result and boundary                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two workers accept simultaneously                                                        | PASS at the Redis acceptance-service/Lua layer: exactly one of two claims won. Not an HTTP-level race test.                                                                                                                                 |
| Expired offer                                                                            | PASS: acceptance returned false, marked it expired, and created no winner.                                                                                                                                                                  |
| Mismatched worker identity                                                               | PASS: offer rejected and no winner created.                                                                                                                                                                                                 |
| Assignment failure after Redis claim                                                     | PASS with a mocked repository failure: rollback removed the winner and restored an unexpired offer to pending. A real PostgreSQL failure injection was not run.                                                                             |
| Duplicate idempotency key, sequential and concurrent                                     | PASS in PostgreSQL integration tests; duplicate requests returned the same booking ID.                                                                                                                                                      |
| Booking ownership and allocation role checks                                             | PASS for the covered customer booking routes and allocation offer/accept roles. User/worker CRUD and reads remain incompletely protected; see the release audit.                                                                            |
| Invalid lifecycle transitions                                                            | Existing service/unit tests pass. The database-backed `ACCEPTED` transition is not valid on a fresh migrated schema (see blocker below).                                                                                                    |
| No eligible worker                                                                       | FAIL: a real booking-create request returned HTTP 201, but its stored status remained `ALLOCATING`; it did not reach a terminal allocation-failed state.                                                                                    |
| Offer expiry progression, tier advancement, recovery, and cancellation-vs-recovery races | NOT VERIFIED: `AllocationExpirationWorker.processExpiredOffers()` is empty, the recovery worker is not started by the server, and the recovery path calls a repository method that does not exist. Do not treat these scenarios as passing. |

## Migration and Runtime Findings

- `pnpm db:migrate` succeeded on a fresh isolated database, but the resulting `booking_status` enum contains `PENDING`, `ALLOCATING`, `ASSIGNED`, `EN_ROUTE`, `WORKING`, `COMPLETED`, and `CANCELLED`; it lacks `ACCEPTED` and `ALLOCATION_FAILED`.
- Read-only command `SELECT 'ACCEPTED'::booking_status` exited **1** with `invalid input value for enum booking_status: "ACCEPTED"`. Therefore the API's assigned-to-accepted transition cannot be persisted on a database created strictly from the committed migrations. No schema/migration was changed.
- Isolated backend probes: `GET /health` returned `200` (`ok`); `GET /ready` returned `200` (`ready`, database `ok`, Redis `ok`).
- Existing Compose stack was not modified or restarted. `docker inspect pronto-backend` reported `Restarting=true`, restart count `39`. The existing shared `localhost:3000/health` and `/ready` probes each returned HTTP `200` during the check, but that does not establish stable container health while it is restarting.
- `docker compose ps` could not render the stack without `JWT_SECRET`; the configuration now intentionally fails closed. Compose syntax passed when supplied the temporary placeholder. No Compose startup was attempted to avoid recreating or disturbing existing services.

## Bounded Performance Run

Inspected `backend/tests/load/allocation.js` before execution. It posts to `POST /v1/bookings`, obtains a test token, and checks response IDs. The original fixed IDs lacked setup; the script now accepts `BASE_URL`, `CUSTOMER_ID`, and `SERVICE_CATEGORY_ID`, and the run used seeded valid fixtures. Existing load remained unchanged: 10 VUs for 30 seconds.

Command:

```powershell
k6 run -e BASE_URL=http://localhost:3300/v1 -e CUSTOMER_ID=4 -e SERVICE_CATEGORY_ID=3 backend/tests/load/allocation.js
```

**Result:** exit 0; 30-second scenario, maximum 10 VUs, 291 booking iterations, 292 HTTP requests including token setup, **9.41 requests/s**, **0/292 failed requests (0%)**, **p50 41.87 ms**, **p95 60.88 ms**, max 115.57 ms. The script's existing thresholds passed. This is a small local booking/first-allocation-path measurement, not a scalability claim; offers were not accepted and expiry/tier progression was not measured.

## Required Before Release

1. Reconcile the booking state machine and PostgreSQL enum through a reviewed migration; add an API integration test proving `ASSIGNED -> ACCEPTED` persists.
2. Implement and start offer expiry/tier progression and recovery; verify no-worker terminal failure, process interruption, and that completed/cancelled/already-assigned bookings are never reassigned.
3. Retain and extend the Redis-to-Postgres compensation tests with a real isolated PostgreSQL failure-injection case and simultaneous HTTP acceptance coverage.
4. Protect the remaining user/worker read and mutation routes, and provide a production authentication flow before exposing the API.
5. Resolve why the existing Compose backend is restarting, then verify stable container health and readiness without recreating existing data volumes.

**Cleanup:** The test-mode API was stopped. Only the two disposable `--rm` validation containers were stopped; they had no volumes. Existing Compose containers and volumes were left untouched.
