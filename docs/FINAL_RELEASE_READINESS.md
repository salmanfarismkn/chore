# Pronto+ Final Release Readiness

**Review date:** 2026-11-04  
**Scope:** Current worktree, allocation reliability Phases 2.2-2.6,
security hardening, migrations, deployment configuration, and recorded
validation evidence.

## 1. Executive assessment

The allocation subsystem has a **CONDITIONAL PASS** based on isolated
PostgreSQL/Redis testing, independent-process lease fencing, live Socket.IO
presence testing, generation-scoped reconciliation, and the passing backend
suite.

The whole marketplace is **not production-release-ready**. The principal
release blockers are:

1. No production authentication or trusted identity-issuance provider exists.
2. Fastify rate limiting is process-local and is not a shared multi-replica
   control.
3. The development Compose file contains development PostgreSQL and pgAdmin
   credentials and publishes database/admin ports; production now has a
   separate Compose file that requires substituted secrets and omits those
   services/ports.
4. Deterministic crash-at-boundary, Redis failover, PostgreSQL failover, and
   deployment-scale tests remain unverified.
5. Migrations 0010 and 0011 and the related source changes are currently
   uncommitted in this worktree.

**Final release decision: NO-GO for public marketplace production.**
Allocation reliability is conditionally acceptable for continued isolated
integration work, not a production-readiness certification for the complete
marketplace.

## 2. Verified architecture and capabilities

- Fastify 5, TypeScript, Drizzle ORM, PostgreSQL, Redis 7, JWT, and
  Socket.IO are the active backend stack.
- PostgreSQL is authoritative for booking status, worker assignment,
  allocation generation, and reconciliation markers.
- Redis stores coordination and ephemeral offer state.
- Migration 0010 adds `bookings.allocation_generation`.
- Migration 0011 adds `bookings.allocation_reconciliation_pending`.
- Allocation leases use `instanceId:generation` tokens.
- Offer creation, tier state, acceptance, assignment, rollback, recovery,
  and terminal cleanup are generation-aware.
- Terminal cleanup is durable and retryable through the existing recovery
  worker; no second queue was introduced.
- Pending offers are indexed globally and per worker:
  `allocation:offers:pending` and
  `worker:<workerId>:offers:pending`.
- Worker disconnect revokes offers only after the final active authenticated
  connection disappears.
- Socket notifications include booking ID, offer ID, worker ID, and
  generation. Acceptance revalidates current Redis and PostgreSQL state.
- Allocation cleanup no longer uses global Redis `KEYS`; indexed paths use
  Redis sets and booking-specific orphan cleanup uses incremental `SCAN`.
- Health is split between liveness (`/health`) and dependency readiness
  (`/ready`).
- Booking creation uses PostgreSQL idempotency records scoped by user and key.
- Authorization is present on the inspected user, worker, worker-service,
  service-category, booking, and allocation routes.

## 3. Exact verification evidence

The following results were actually recorded against disposable PostgreSQL
16.15 and Redis 7 containers with unique databases/ports and no persistent
volumes:

| Check | Result |
|---|---|
| Complete migration chain, including 0010 and 0011 | PASS; 12 migration records applied |
| PostgreSQL schema columns for generation/reconciliation | PASS |
| Independent application-process fencing harness | PASS |
| Live Socket.IO multi-connection harness | PASS |
| Focused fencing/reconciliation/presence tests | PASS; 4 files, 21 tests |
| Full backend Vitest suite | PASS; 14 files, 108 tests |
| Backend `pnpm exec tsc --noEmit` | PASS |
| Workspace `pnpm build` | PASS |
| `git diff --check` | PASS |

Commands used for reproducible repository checks:

```powershell
Set-Location C:\Users\salma\chore\backend
pnpm exec vitest run --reporter=dot
pnpm exec tsc --noEmit
Set-Location C:\Users\salma\chore
pnpm build
git diff --check
```

The Vitest and migration results require isolated `DATABASE_URL`,
`REDIS_URL`, a test-only JWT secret of at least 32 characters, and
`SKIP_TEST_DB_SETUP=1` where the database was already migrated.

The independent-process test verified separate instance IDs, lease takeover
from generation 1 to 2, stale offer/renewal/release/assignment rejection, and
preservation of the newer lease and offer.

The live Socket.IO test verified two connections, one-connection survival,
reconnection before a stale disconnect, final-disconnect revocation,
notification identifiers, and rejection of acceptance after revocation.

## 4. Security and operational limitations

### Authentication

`/v1/auth/test-token` is test-mode-only. There is no production login,
refresh, phone verification, token revocation, or trusted production identity
provider. This is a release blocker, not an allocation-test limitation.

### Rate limiting

`@fastify/rate-limit` is registered with `global: false` and explicit limits
for authentication, booking creation, and allocation acceptance. The store is
process-local. Multiple backend replicas therefore do not share counters and
can collectively exceed the configured limits.

### Compose and secrets

`infrastructure/docker/docker-compose.yml` is explicitly development-only and
retains local data/admin port mappings. Production uses
`infrastructure/docker/docker-compose.production.yml`, which requires database,
Redis, JWT, and CORS values through Compose substitution, persists PostgreSQL
and Redis data, excludes pgAdmin, and publishes only the backend port.
Compose files alone are not a production-grade secrets manager or HA
deployment. `JWT_SECRET` and other required production values fail closed
when missing; known development placeholders and local data endpoints are
rejected.

### Database and Redis operations

PostgreSQL and Redis are not transactionally atomic. Reconciliation is
compensating and depends on Redis availability and the recovery worker.
PostgreSQL client shutdown handling and production failover behavior were not
validated. No Redis or PostgreSQL failover test was executed.

### Logging and responses

The application has structured operational logging and avoids returning JWT
verification details. Production log retention, redaction policy, alerting,
and centralized audit storage were not verified.

## 5. Unverified production scenarios

These are **NOT VERIFIED**, not passing results:

- Forced process termination after Redis winner acquisition and before
  PostgreSQL assignment.
- Forced process termination after PostgreSQL assignment and before Redis
  cleanup.
- Forced process termination after terminal booking transition and before
  cleanup.
- Restart and completion of durable reconciliation after a real process
  crash.
- Redis network partition, failover, or data loss behavior.
- PostgreSQL failover and connection-pool recovery.
- Deployment-scale latency and memory behavior for offer indexes and
  reconciliation.
- Stable multi-replica rate-limit enforcement.
- Production authentication and active-user/role revocation behavior.

The local allocation evidence must not be interpreted as marketplace
production readiness or as proof of exactly-once behavior across PostgreSQL,
Redis, and Socket.IO.

## Milestone A.1 verification — 2026-11-04

Production configuration hardening is implemented without changing the
database schema, authentication design, or rate-limit design:

- Development Compose remains in
  `infrastructure/docker/docker-compose.yml` with its local-only database,
  Redis, and pgAdmin mappings.
- Production Compose is
  `infrastructure/docker/docker-compose.production.yml`; it requires
  substituted PostgreSQL, Redis, JWT, and CORS values, keeps PostgreSQL and
  Redis un-published, excludes pgAdmin, persists data volumes, and waits for
  healthy dependencies before starting the backend.
- `backend/src/config/env.ts` rejects missing production Redis/CORS settings,
  known placeholder JWT values, local database/Redis endpoints, and
  placeholder connection values without printing secret contents.
- Test-only environment values are now supplied by ignored local test
  configuration or test-runner defaults; no committed `.env` file contains
  credentials.
- Migration-before-server startup and the test-only `/v1/auth/test-token`
  gate are unchanged.

Actual commands and results:

| Command | Result |
|---|---|
| `Set-Location backend; $env:SKIP_TEST_DB_SETUP='1'; pnpm exec vitest run src/config/env.test.ts --reporter=dot` | PASS; 1 file, 6 tests |
| `Set-Location backend; pnpm exec tsc --noEmit` | PASS |
| `pnpm build` | PASS; 3 successful workspace tasks |
| `docker compose -f infrastructure/docker/docker-compose.yml config --quiet` | PASS |
| `docker compose -f infrastructure/docker/docker-compose.production.yml config --quiet` | PASS with supplied validation-only environment values |
| `git diff --check` | PASS |

No containers or application services were started. Compose validation confirms
rendering and required substitutions only; it does not verify deployment
secrets management, HA, backups, failover, or production network policy.

## 6. Deployment prerequisites

Before any public deployment:

1. Integrate a production authentication and identity provider.
2. Apply and verify migrations 0010 and 0011 through the deployment migration
   process; do not rely on `drizzle-kit push` for production schema changes.
3. Commit and review all required source, migration, snapshot, and journal
   changes.
4. Supply production Compose values through managed secrets and keep
   PostgreSQL/Redis on private networks; never use the development Compose
   file for public deployment.
5. Decide on a distributed rate-limit design for multiple replicas.
6. Configure `TRUST_PROXY` only for the actual trusted proxy topology.
7. Verify Redis and PostgreSQL backups, restore procedures, failover, and
   monitoring.
8. Run deterministic crash/restart tests against deployment-like isolated
   infrastructure.
9. Keep `/ready` behind the deployment health-check path and verify stable
   process restarts, not only point-in-time HTTP responses.

## 7. Known risks and recommended future work

- Add failure-injection hooks or a deployment test harness for each
  PostgreSQL/Redis cross-system boundary.
- Add a shared rate-limit store or an edge/API-gateway control appropriate to
  the replica topology.
- Replace development Compose secrets and public data-service ports with a
  production-specific deployment configuration.
- Establish authentication, authorization, token revocation, and audit-log
  integration tests using the real identity provider.
- Measure Redis index cardinality, reconciliation latency, and recovery
  throughput under representative load.
- Add CI jobs that provision isolated PostgreSQL and Redis and run the
  migration, full backend, multi-process, and Socket.IO suites.

## 8. Documentation and repository alignment

The current worktree contains the following uncommitted implementation and
documentation changes:

- Redis index/SCAN changes in
  [config/redis.ts](../backend/src/config/redis.ts) and
  [allocation-offer.service.ts](../backend/src/modules/allocation/allocation-offer.service.ts).
- Generation, lease, reconciliation, terminal cleanup, and allocation test
  changes across the allocation and realtime modules.
- Migrations
  [0010_allocation-generation.sql](../backend/src/db/migrations/0010_allocation-generation.sql)
  and
  [0011_allocation-reconciliation.sql](../backend/src/db/migrations/0011_allocation-reconciliation.sql),
  their snapshots, and the migration journal.
- This report and the updated allocation reliability audit.

Older sections of `RELEASE_AUDIT.md`, `VALIDATION_REPORT.md`, and `README.md`
retain historical evidence, but their pre-Phase-2 statements must not be read
as the current implementation state. The current allocation state and
limitations are recorded in
[ALLOCATION_RELIABILITY_AUDIT.md](ALLOCATION_RELIABILITY_AUDIT.md) and this
report.
