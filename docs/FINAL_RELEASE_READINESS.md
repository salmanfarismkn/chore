# Pronto+ Final Release Readiness

**Review date:** 2026-11-06
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

1. A.6/A.7 implement PostgreSQL-backed sessions, local authorization, and a
   worker approval lifecycle, but real Auth0 registration and verified-phone
   onboarding remain unverified release blockers.
2. A.9 adds Redis-shared rate limits, but production Redis failover,
   proxy-chain behavior, traffic tuning, and load characteristics remain
   unverified.
3. The development Compose file contains development PostgreSQL and pgAdmin
   credentials and publishes database/admin ports; production now has a
   separate Compose file that requires substituted secrets and omits those
   services/ports.
4. Deterministic crash-at-boundary, Redis failover, PostgreSQL failover, and
   deployment-scale tests remain unverified.
5. Milestone implementation and migration changes in this worktree remain
   uncommitted; no commit or push was made.

**Final release decision: NO-GO for public marketplace production.**
Allocation reliability is conditionally acceptable for continued isolated
integration work, not a production-readiness certification for the complete
marketplace.

## 2. Verified architecture and capabilities

- Fastify 5, TypeScript, Drizzle ORM, PostgreSQL, Redis 7, Auth0 OIDC, and
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

| Check                                                   | Result                             |
| ------------------------------------------------------- | ---------------------------------- |
| Complete migration chain, including 0010 and 0011       | PASS; 12 migration records applied |
| PostgreSQL schema columns for generation/reconciliation | PASS                               |
| Independent application-process fencing harness         | PASS                               |
| Live Socket.IO multi-connection harness                 | PASS                               |
| Focused fencing/reconciliation/presence tests           | PASS; 4 files, 21 tests            |
| Full backend Vitest suite                               | PASS; 14 files, 108 tests          |
| Backend `pnpm exec tsc --noEmit`                        | PASS                               |
| Workspace `pnpm build`                                  | PASS                               |
| `git diff --check`                                      | PASS                               |

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
`REDIS_URL`, and
`SKIP_TEST_DB_SETUP=1` where the database was already migrated.

The independent-process test verified separate instance IDs, lease takeover
from generation 1 to 2, stale offer/renewal/release/assignment rejection, and
preservation of the newer lease and offer.

The live Socket.IO test verified two connections, one-connection survival,
reconnection before a stale disconnect, final-disconnect revocation,
notification identifiers, and rejection of acceptance after revocation.

## 4. Security and operational limitations

### Authentication

`/v1/auth/test-token` is test-mode-only and creates a session only for an
existing active local user. A.5/A.6 implement authorization-code + PKCE,
transaction context binding, PostgreSQL-backed sessions, logout, CSRF, and
current local role/account checks. No refresh flow exists. Real Auth0
configuration, phone verification, customer/worker onboarding, and safe
first-administrator provisioning remain incomplete release blockers. Worker
approval is implemented by A.7 but still requires production operational
validation.

### Rate limiting

A.9 replaces the process-local Fastify store with atomic Redis fixed-window
counters. General API traffic is limited to 300 requests per 60 seconds per
trusted IP, HTTP method, and registered route template. Separate defaults are
10/minute per IP for login initiation, callback/exchange, and logout; 10/minute
per local user for session revoke/CSRF renewal and sensitive administrator
operations; 20/minute per local user for booking creation; 30/minute per worker
for each offer/booking acceptance route; 10/minute per local user for
administrator user/service/worker/profile/service mutations and manual offer
creation; and 60/minute per direct TCP peer IP for Socket.IO handshakes.
Health/readiness endpoints are excluded. Values are
configurable in the production Compose environment; see
[PRODUCTION_AUTH_ARCHITECTURE.md](PRODUCTION_AUTH_ARCHITECTURE.md) for all
policy categories and key rules.

HTTP IP identity comes from Fastify `request.ip` and obeys explicit
`TRUST_PROXY` configuration; production rejects unrestricted proxy trust.
Socket.IO uses its direct peer address and ignores forwarded IP headers, which
can aggregate users behind one ingress. Authentication buckets are IP-based,
not keyed by user-supplied account names. Redis Lua provides atomic increments
and TTL; 429 responses include a TTL-derived `Retry-After`. Redis unavailable
fails closed for versioned API requests and Socket.IO handshakes with generic
503/handshake errors. No process-local fallback exists. Liveness remains
unthrottled and readiness still checks Redis.

The fixed window is intentionally simpler than a sliding window and permits
short bursts across adjacent boundaries. Defaults have not been tuned using
production traffic or load tests.

### Compose and secrets

`infrastructure/docker/docker-compose.yml` is explicitly development-only and
retains local data/admin port mappings. Production uses
`infrastructure/docker/docker-compose.production.yml`, which requires database,
Redis, Auth0 issuer/client/redirect settings, session TTL, trusted TLS ingress,
and CORS values through Compose substitution, persists PostgreSQL and Redis data,
excludes pgAdmin, and publishes only the backend port.
Compose files alone are not a production-grade secrets manager or HA
deployment. Required production values fail closed when missing; known
development placeholders and local data endpoints are rejected.

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
- Real Auth0 deployment behavior and production active-user/role revocation
  under deployment failover.

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

| Command                                                                                                         | Result                                                |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Set-Location backend; $env:SKIP_TEST_DB_SETUP='1'; pnpm exec vitest run src/config/env.test.ts --reporter=dot` | PASS; 1 file, 6 tests                                 |
| `Set-Location backend; pnpm exec tsc --noEmit`                                                                  | PASS                                                  |
| `pnpm build`                                                                                                    | PASS; 3 successful workspace tasks                    |
| `docker compose -f infrastructure/docker/docker-compose.yml config --quiet`                                     | PASS                                                  |
| `docker compose -f infrastructure/docker/docker-compose.production.yml config --quiet`                          | PASS with supplied validation-only environment values |
| `git diff --check`                                                                                              | PASS                                                  |

No containers or application services were started. Compose validation confirms
rendering and required substitutions only; it does not verify deployment
secrets management, HA, backups, failover, or production network policy.

## 6. Deployment prerequisites

Before any public deployment:

1. Provision and verify real Auth0 web/native application registrations and
   trusted TLS ingress. Implement phone verification and customer/worker
   onboarding, and validate the A.7 worker approval operations before release.
2. Apply and verify migrations 0010 through 0014 through the deployment
   migration process; do not rely on `drizzle-kit push` for production schema
   changes.
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

## Milestone A.3 — Auth0 external identity mapping (2026-11-06)

The approved identity provider is Auth0 for React Native mobile and web
clients. A.3 adds the PostgreSQL identity mapping table, Drizzle migration,
repository, internal mapping service, and focused integration tests.

- `auth_identities` uses the existing serial integer ID convention, references
  `users.id` with `ON DELETE CASCADE`, and uniquely indexes `(issuer, subject)`
  and `user_id`.
- The migration does not backfill identities for existing users or infer
  ownership from email/phone. A disposable pre-migration database check
  preserved two existing users and one worker profile and created zero
  mappings.
- Identity lookup and linking do not create or activate users, change roles,
  or alter worker profiles. Phone remains required; verified-phone enforcement
  is not implemented.
- Production OIDC login/callback, public registration, JWT issuance,
  backend-managed sessions, phone verification, and onboarding remain
  unimplemented. Authentication is not complete and remains a release blocker.

Verification used disposable PostgreSQL 16 and Redis 7 instances bound only to
localhost:

| Check                                            | Result                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Complete Drizzle migration chain, including 0012 | PASS; all 13 migrations applied                                     |
| Existing-user migration preservation             | PASS; 2 users and 1 worker profile preserved, 0 mappings backfilled |
| Identity mapping integration tests               | PASS; 1 file, 13 tests                                              |
| Existing user and worker tests                   | PASS; 2 files, 9 tests                                              |
| Full backend suite                               | PASS; 16 files, 127 tests                                           |
| Drizzle migration snapshot check                 | PASS                                                                |
| Backend build and no-emit TypeScript check       | PASS                                                                |
| Workspace `pnpm check-types`                     | PASS                                                                |
| Workspace `pnpm build`                           | PASS; 3 build tasks                                                 |
| `git diff --check`                               | PASS                                                                |

These results verify local schema and repository behavior only. They do not
verify production Auth0 configuration, phone ownership, user onboarding, or
production authentication/session behavior.

## Milestone A.4 — Auth0 OIDC identity verification (2026-11-06)

A.4 adds an internal Auth0 ID-token verifier using the maintained `jose`
library and a resolver that passes only verified issuer/subject claims to the
A.3 mapping service. It adds no authentication routes, application JWTs,
sessions, account linking, or onboarding behavior.

- Verification pins RS256, the exact configured HTTPS issuer, a configured
  allowlist of web/native Auth0 client IDs, `exp`, `nbf`, a maximum 10-minute
  token age, required subject and issued-at claims, and equality with the
  expected trusted-flow nonce. Five seconds of clock tolerance is allowed.
- JWKS retrieval uses `jose` remote-key caching with a 10-minute cache age,
  five-second fetch timeout, and 30-second unknown-key refresh cooldown. The
  JWKS URL is fixed under the configured issuer; unavailable keys fail closed.
- The result contains only identity and optional contact claims. Provider roles
  and permissions are not returned or used as local authorization data.
- Production requires `AUTH0_ISSUER` and `AUTH0_CLIENT_IDS`. The production
  Compose file forwards both required values. Client IDs are not supplied by
  requesters, and the verifier requires no provider secret.

Verification ran with generated RS256 signing keys and a local JWKS HTTP server;
no Auth0 tenant or credentials were used:

| Check                                                          | Result                    |
| -------------------------------------------------------------- | ------------------------- |
| Focused verifier and identity-resolution tests                 | PASS; 1 file, 22 tests    |
| A.3 identity mapping tests                                     | PASS; 1 file, 12 tests    |
| Environment, A.3 mapping, user authorization, and worker tests | PASS; 4 files, 30 tests   |
| Full backend suite on isolated PostgreSQL/Redis                | PASS; 17 files, 151 tests |
| Backend build and `pnpm exec tsc --noEmit`                     | PASS                      |
| Workspace `pnpm check-types` and `pnpm build`                  | PASS                      |
| Production Compose configuration with Auth0 settings           | PASS                      |
| `git diff --check`                                             | PASS                      |

At A.4 completion, the real Auth0 tenant, web/native registrations, and
transaction lifecycle were not verified or implemented. Milestone A.5 below
adds the local authorization-code transaction and callback/exchange boundary;
real provider verification, phone verification, and app sessions remain
unverified or deferred.

## Milestone A.5 — Auth0 authorization-code + PKCE flow (2026-11-06)

A.5 adds public transaction-start and callback/exchange endpoints for distinct
web and React Native Auth0 applications. The selected architecture is client
callback followed by backend exchange: each client receives an allowlisted
callback, forwards only `code` and `state` to the backend, and never receives
provider or Pronto+ session tokens.

- The backend creates independent cryptographically random state, nonce, and
  PKCE verifier values; only the S256 challenge is sent to Auth0. Transactions
  bind the exact client ID and redirect URI and expire after 600 seconds.
- Transactions are kept in shared Redis under a SHA-256 state key, with Redis
  TTL cleanup and a Lua GET+DEL consume operation. Concurrent/replayed
  callbacks cannot consume the same transaction twice. Redis outages fail
  closed.
- The backend exchanges authorization codes over HTTPS against the fixed
  issuer-derived token endpoint, verifies the ID token with A.4 including the
  transaction's exact client audience and nonce, and resolves exact
  `(issuer, subject)` mappings through A.3.
- Unlinked identities return `identity_not_linked`; inactive accounts are
  rejected. The success response is only `identity_verified`; no user,
  identity, role, account state, or application credential is returned or
  changed, and no provider token is returned or persisted.
- Production requires `AUTH0_ISSUER`, `AUTH0_CLIENT_IDS`,
  `AUTH0_WEB_CLIENT_ID`, `AUTH0_NATIVE_CLIENT_ID`,
  `AUTH0_WEB_REDIRECT_URIS`, and `AUTH0_NATIVE_REDIRECT_URIS`. The combined
  client list must exactly match the two distinct app IDs. Web callbacks must
  be HTTPS; native callbacks must be exact HTTPS app links or registered
  custom schemes. `TRUST_PROXY` must match the TLS ingress; unrestricted
  `true` and disabled proxy trust are rejected.
- Existing Fastify rate limits are applied to both routes, but remain
  process-local. No client secret, API audience, offline-access scope, Auth0
  SDK, login session, JWT issuance, phone verification, or onboarding flow was
  added.

Verification ran with disposable PostgreSQL 16 and Redis 7 containers bound to
localhost, no persistent volumes, generated RS256 signing keys, and a local
JWKS server. No Auth0 tenant or credentials were used:

| Check                                                    | Result |
| -------------------------------------------------------- | ------ |
| Complete Drizzle migration chain on fresh disposable DB  | PASS; 13 migrations |
| Focused A.5, A.3/A.4, environment, user and worker tests  | PASS; 8 files, 79 tests |
| Redis transaction TTL and concurrent atomic consumption | PASS; included in focused suite |
| Full backend suite                                       | PASS; 20 files, 178 tests |
| Backend `pnpm exec tsc --noEmit` and `pnpm build`        | PASS |
| Workspace `pnpm check-types` and `pnpm build`            | PASS; 3 build tasks |
| Production Compose configuration                        | PASS; validation-only values |
| `git diff --check`                                       | PASS |

Real Auth0 application registrations, callback delivery, token exchange,
tenant JWKS/rotation, and production TLS proxy behavior are **NOT VERIFIED**.
At the A.5 checkpoint Redis failover and distributed rate limiting were also
unverified; A.9 now verifies shared counters across independently constructed
app instances, while production Redis failover and deployment proxy behavior
remain unverified. The success response was not a session or authorization
credential at that checkpoint; later milestones implement local sessions and
authorization. Authentication remains a release blocker pending production
validation.

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

## Milestone A.6 — PostgreSQL application sessions and local authorization

A.6 replaces the earlier JWT application-authentication path with opaque
PostgreSQL-backed sessions. The session table stores a UUID, local user ID,
client type, SHA-256 verifier, optional web CSRF verifier, creation/expiry/last
use timestamps, and revocation timestamp. It stores no raw session secret or
Auth0 token. The default lifetime is one hour, configurable from 300 to 86400
seconds; there is no refresh-token flow.

Web credentials are set only in a Secure, HttpOnly, SameSite=None cookie scoped
to `/v1`; state-changing cookie requests require an exact trusted Origin and
matching `X-CSRF-Token`. Native clients receive the local bearer credential
over HTTPS and must store it using platform secure storage. Mixed cookie and
bearer credentials are rejected. Logout revokes the current credential;
`POST /v1/auth/sessions/revoke` revokes all sessions for the authenticated
local user.

The A.5 review found state, nonce, PKCE verifier, exact client/redirect
allowlists, atomic Redis consumption, and fail-closed Redis errors. It found no
identity/contact-based account linking or open redirect. It did find that
callback completion was not bound to the initiating browser/app context. A.6
adds a state-scoped web context cookie or a random native transaction binding;
callback attempts without the correct context are rejected. Failed/replayed
callbacks cannot create a session.

Each protected HTTP request checks the session, current local account state,
and current PostgreSQL role. Worker actions also require a present,
non-deleted, non-suspended, approved worker profile; accepting work requires
operational status `available`. This is the A.6 baseline; A.7 adds durable
worker approval and its marketplace gates.
No verified-phone state or OTP delivery flow exists; required phone numbers
must not be treated as verified. At the A.6 checkpoint, rate limits were
process-local; A.9 supersedes that status with the Redis-backed policy below.
Socket.IO revalidates every event and every 15 seconds while idle; an already
authorized in-flight operation may complete.

The following checks ran against fresh disposable PostgreSQL 16 and Redis 7
containers bound only to localhost, with no persistent volumes. No live Auth0
credentials were used:

| Check | Result |
| ----- | ------ |
| Complete Drizzle migration chain on fresh DB | PASS; 14 migrations applied |
| `drizzle-kit check` | PASS |
| Focused A.3-A.6 regression/integration tests | PASS; 9 files, 82 tests |
| Complete backend Vitest suite | PASS; 24 files, 200 tests |
| Backend `pnpm exec tsc --noEmit` and `pnpm build` | PASS |
| Workspace `pnpm check-types` and `pnpm build` | PASS; 3 build tasks |
| Production Compose `config --quiet` using placeholder example values | PASS |
| `git diff --check` | PASS; no whitespace errors |

The focused and full suites exercised PostgreSQL session persistence,
two independently constructed Fastify instances observing revocation,
current role/account/worker-state checks, web CSRF and native transport,
callback context binding, and atomic Redis transaction consumption.

**NOT VERIFIED at the A.6 checkpoint:** a real Auth0 tenant/application setup,
live callback and token exchange, production TLS proxy topology,
Redis/PostgreSQL failover, phone
verification/onboarding, and production monitoring/secrets management. A.6
was not a production authentication certification; public marketplace release
remains **NO-GO**. A.7 verification is recorded below.

## Milestone A.7 — Worker approval lifecycle

Worker approval is now represented separately from operational status with
`pending`, `approved`, and `rejected` values. Migration 0014 adds the state
with a `pending` default for every existing worker profile, preserving
profiles and bookings without implicitly approving any worker. Operational
`suspended` remains separate. Only a locally authenticated administrator may
approve or reject a worker; requests cannot set approval during worker
creation or profile updates. Decisions record the administrator and timestamp.
Repeated identical decisions are idempotent. Rejection is terminal in this
milestone; no reapproval path is implemented.

Allocation candidate selection, offer creation, final PostgreSQL assignment,
worker HTTP authorization, and Socket.IO authorization require approval.
Rejection revokes outstanding offers; PostgreSQL eligibility checks remain
authoritative if Redis revocation fails. Existing assigned and in-progress
bookings are preserved and are not silently canceled; approval-gated worker
actions are denied, so an operator must safely resolve any active work.
Socket.IO checks approval on every inbound event and when an idle connection
is revalidated (nominally every 15 seconds). In-flight operations and
scheduling/network delay can extend that bound.

The A.6 evidence above is historical and does not include this milestone.
A.7 verification used only disposable local PostgreSQL 16 and Redis 7
containers bound to localhost; no shared development database or live Auth0
tenant was used.

| Check | Result |
| ----- | ------ |
| Complete Drizzle migration chain on fresh database | PASS; 15 migrations applied |
| Migration against preexisting worker and booking records | PASS; worker defaulted to `pending`, existing `WORKING` booking and assignment were preserved |
| `pnpm --filter backend exec drizzle-kit check` | PASS |
| Focused A.7, allocation, session, Socket.IO, and A.3-A.6 regression tests | PASS; 16 files, 153 tests |
| Final worker/allocation integration tests after offer-race guard | PASS; 3 files, 15 tests |
| Complete backend Vitest suite | PASS; 25 files, 205 tests |
| `pnpm --filter backend exec tsc --noEmit` | PASS |
| Workspace `pnpm check-types` | PASS; 3 workspace tasks |
| Workspace `pnpm build` | PASS; backend, web, and docs |
| Production and development Compose config validation | PASS |
| `git diff --check` | PASS |

Focused integration exercised candidate exclusion, offer revocation,
PostgreSQL assignment protection, existing accepted/in-progress booking
preservation, and worker Socket.IO disconnect after approval revocation.
Manual migration preservation applied the earlier chain through 0013 to a
disposable database with seeded worker/booking records, then applied migration
0014 and queried the preserved state.

**NOT VERIFIED at the A.7 checkpoint:** production deployment/failover
behavior, multi-replica Redis failure timing, real Auth0, phone ownership
verification/onboarding, first-administrator provisioning, and approval
auditing. A.8 adds the provisioning and application-level approval audit
mechanisms described below; production phone verification/onboarding and
deployment scenarios remain unverified, so production readiness remains
**NO-GO**.

## Milestone A.8 — Initial administrator and approval audit

The A.8 implementation adds an offline-only bootstrap command at
`backend/src/scripts/bootstrap-admin.ts`; no HTTP bootstrap route is exposed.
An operator must inject a 32-byte cryptographically generated base64url
`ADMIN_BOOTSTRAP_SECRET` into a one-off production task and provide only the
operator-verified local user ID. The candidate must be active, have a linked
Auth0 identity, and still have the `customer` role. No user or role is accepted
from an HTTP client. Migration 0015 seeds a singleton PostgreSQL marker;
promotion and marker consumption are one transaction. Competing attempts
serialize on the marker. Existing administrators close bootstrap, and a
completed marker is not reset when an admin is later demoted or removed.
Remove the secret from its secret manager immediately after successful
provisioning. The exact command and failure recovery procedure are documented
in [PRODUCTION_AUTH_ARCHITECTURE.md](PRODUCTION_AUTH_ARCHITECTURE.md).

Worker approval changes now check the active local administrator inside the
transaction, lock the worker profile, update its status, and insert a
`worker_approval_audit_events` row atomically. Duplicate identical decisions
remain idempotent and do not add events; rejected remains terminal. The
application exposes no audit update/delete operations or mutation routes.
This is not database-level immutability: a database owner can still alter the
table or rows. Event rows retain actor/profile numeric identifiers without
foreign keys so parent deletion cannot cascade away history.

**A.8 verification:** performed only with disposable local PostgreSQL/Redis
and is reported below. Real secret-manager injection, production database
roles, deployment failover, actual Auth0 tenant operations, and break-glass
recovery are **NOT VERIFIED**. The project still lacks a separate
administrator recovery workflow. Phone verification/onboarding remains
unimplemented; production readiness remains **NO-GO**.

| A.8 check | Result |
| --------- | ------ |
| Fresh complete Drizzle migration chain | PASS; 16 migrations applied |
| `pnpm --filter backend exec drizzle-kit check` | PASS |
| A.8 bootstrap, approval-audit, and route tests | PASS; 4 files, 19 tests |
| A.7 approval/allocation plus A.3-A.6 regression tests | PASS; 18 files, 159 tests |
| Complete backend Vitest suite | PASS; 27 files, 211 passed, 1 gated file / 4 gated tests skipped |
| Legacy worker/booking preservation through migration 0015 | PASS; existing approved worker and `WORKING` assignment unchanged; bootstrap marker available; no audit rows created |
| Backend `pnpm --filter backend exec tsc --noEmit` | PASS |
| Workspace `pnpm check-types` and `pnpm build` | PASS |
| Production and development Compose config validation | PASS |
| `git diff --check` | PASS |

The bootstrap integration file is gated by
`RUN_ADMIN_BOOTSTRAP_INTEGRATION=1` so the one-time singleton state is not
consumed by an ordinary shared test run. Its tests ran separately against the
disposable PostgreSQL database with the complete migration chain applied.
The test verified no-admin eligibility, existing-admin closure, concurrent
attempt serialization, post-success non-reuse, wrong-secret rejection,
unmapped-user rejection, and no secret in command error output. Audit
integration verified serialized transitions, idempotency, local admin checks,
application-route mutation absence, and transaction rollback on a failed
audit insert.

Commands used (connection values omitted):

```text
pnpm --filter backend exec drizzle-kit migrate
pnpm --filter backend exec drizzle-kit check
pnpm --filter backend exec vitest run src/modules/admin-bootstrap/admin-bootstrap.service.test.ts src/modules/admin-bootstrap/admin-bootstrap.integration.test.ts src/modules/workers/worker-approval-audit.integration.test.ts src/modules/workers/workers.routes.test.ts --reporter=dot --silent
pnpm --filter backend exec vitest run src/modules/admin-bootstrap/admin-bootstrap.service.test.ts src/modules/workers/worker-approval-audit.integration.test.ts src/modules/workers/worker-approval.integration.test.ts src/modules/workers/workers.routes.test.ts src/modules/sessions/session.repository.integration.test.ts src/modules/sessions/session.service.test.ts src/plugins/session-auth.test.ts src/modules/allocation/allocation.integration.test.ts src/modules/allocation/allocation-concurrency.test.ts src/modules/allocation/allocation-fencing.test.ts src/modules/allocation/allocation-reconciliation.test.ts src/realtime/worker-presence.test.ts src/realtime/socket.test.ts src/modules/bookings/booking-status.test.ts src/modules/auth/auth.routes.test.ts src/modules/auth/auth0-authorization-code-flow.test.ts src/modules/auth/auth0-id-token-verifier.test.ts src/modules/auth/auth0-login-transaction.test.ts --reporter=dot --silent
pnpm --filter backend exec vitest run --reporter=dot --silent
pnpm --filter backend exec tsc --noEmit
pnpm check-types
pnpm build
git diff --check
```

The A.8 bootstrap integration command additionally used
`RUN_ADMIN_BOOTSTRAP_INTEGRATION=1`; integration and full-suite commands used
`SKIP_TEST_DB_SETUP=1` with only the disposable local PostgreSQL/Redis URLs.

## Milestone A.9 — Distributed rate limiting

The local process-store implementation has been replaced with a Redis Lua
fixed-window counter. General API and operation-specific policies use separate
keys; authenticated operations key by local user ID, public auth endpoints by
trusted HTTP client IP, and Socket.IO handshakes by direct TCP peer IP.
Identifiers are SHA-256 hashed into bounded key names and every counter has a
TTL. General API keys include the method and Fastify route template, not raw
request paths or caller-provided identifiers. The complete policy table,
window-boundary trade-off, proxy behavior, 429/`Retry-After` format, and
fail-closed Redis behavior are documented in
[PRODUCTION_AUTH_ARCHITECTURE.md](PRODUCTION_AUTH_ARCHITECTURE.md).

Redis unavailable returns a generic 503 for registered `/v1` routes and
rejects Socket.IO connection handshakes; the code does not fall back to
process-local state. Health and readiness routes are excluded from rate
limiting (readiness still checks Redis health). Socket.IO does not perform
Redis work for harmless events; only handshakes are limited.

| A.9 verification | Result |
| ---------------- | ------ |
| Rate-limit unit, HTTP policy, trusted proxy, health, and Socket.IO tests | PASS; 4 files, 15 tests |
| Redis integration across two independently constructed apps and clients | PASS; concurrent atomic limit, expiry/reset, Retry-After, separate user buckets |
| A.3-A.9 auth/session/booking/worker/allocation/socket/rate-limit regression batch | PASS; 25 files, 202 tests |
| Complete backend Vitest suite | PASS; 29 files passed, 1 gated file skipped; 221 tests passed, 4 skipped |
| Fresh PostgreSQL migration chain through 0015 | PASS; 16 migrations applied to a new disposable database |
| Backend type-check and build | PASS |
| Workspace `pnpm check-types` and `pnpm build` | PASS |
| Production and development Compose config validation | PASS |
| `git diff --check` | PASS |

Commands used:

```text
pnpm --filter backend exec drizzle-kit migrate
pnpm --filter backend exec vitest run src/config/rate-limit.test.ts src/modules/security.rate-limit.test.ts src/modules/security.distributed-rate-limit.integration.test.ts src/realtime/socket.test.ts --reporter=dot
pnpm --filter backend exec vitest run src/config/env.test.ts src/config/rate-limit.test.ts src/modules/security.rate-limit.test.ts src/modules/security.distributed-rate-limit.integration.test.ts src/modules/auth-identities/identity-mapping.test.ts src/modules/auth/auth.routes.test.ts src/modules/auth/auth0-authorization-code-flow.test.ts src/modules/auth/auth0-id-token-verifier.test.ts src/modules/auth/auth0-login-transaction.test.ts src/modules/sessions/session.repository.integration.test.ts src/modules/sessions/session.service.test.ts src/plugins/session-auth.test.ts src/modules/bookings/booking-status.test.ts src/modules/bookings/bookings.integration.test.ts src/modules/users/users.authorization.test.ts src/modules/workers/workers.routes.test.ts src/modules/workers/worker-approval.integration.test.ts src/modules/workers/worker-approval-audit.integration.test.ts src/modules/worker-services/worker-services.authorization.test.ts src/modules/allocation/allocation.integration.test.ts src/modules/allocation/allocation-concurrency.test.ts src/modules/allocation/allocation-fencing.test.ts src/modules/allocation/allocation-reconciliation.test.ts src/realtime/socket.test.ts src/realtime/worker-presence.test.ts --reporter=dot --silent
pnpm --filter backend exec vitest run --reporter=dot --silent
pnpm --filter backend exec tsc --noEmit
pnpm --filter backend build
pnpm check-types
pnpm build
docker compose --env-file infrastructure/docker/.env.production.example -f infrastructure/docker/docker-compose.production.yml config --quiet
docker compose --env-file infrastructure/docker/.env.production.example -f infrastructure/docker/docker-compose.yml config --quiet
git diff --check
```

Redis integration used
`RUN_RATE_LIMIT_REDIS_INTEGRATION=1` and
`RATE_LIMIT_TEST_REDIS_URL` pointing only to the disposable local Redis
instance (database 15); OIDC integration used another logical DB. PostgreSQL
integration used a newly created local disposable database and the complete
migration chain. No shared or production service was used.

**NOT VERIFIED:** production Redis failover/eviction behavior, real deployment
proxy-chain identity, production traffic tuning, and load/performance
characteristics. Limits are configurable starting policies, not evidence of
production capacity. Production readiness remains **NO-GO**.

## Milestone A.10 — Production deployment and resilience validation

Validation ran on 2026-11-06 against newly created, loopback-only PostgreSQL
16 and Redis 7.4.10 containers. Two separately launched Node/tsx backend
processes used separate ports and shared those services. The host runtime was
Node 24.16.0; the production Dockerfile specifies Node 22, so the exact
production runtime was not exercised. Test-only Auth0 values used an
`.invalid` issuer; no live provider credentials, tenant, or production
ingress were used.

### Inventory and deployment assumptions

- `backend/src/start.ts` runs Drizzle migrations before importing the server.
  Concurrent direct `drizzle-kit migrate` commands against a fresh disposable
  database produced one successful and one nonzero exit; the final schema
  contained all 16 migrations. Drizzle's migration runner does not serialize
  that direct invocation. The startup path now holds PostgreSQL advisory lock
  `(17103, 10)` across the migration command. Two concurrent `src/start.ts`
  processes on a new database both became ready and applied exactly 16
  migrations. Run backend replicas through this locked startup path; do not
  run direct migration commands concurrently.
- The production Compose file defines one backend service and publishes its
  host port. It does not define an ingress/load balancer or a multi-replica
  topology. Scaling that service on one host with the same published port is
  not demonstrated by Compose validation.
- `backend/src/db/index.ts` calls `postgres(DATABASE_URL)` without explicit
  pool or query-timeout options. The installed postgres.js defaults are
  `max: 10`, `idle_timeout: 0`, and `connect_timeout: 30` seconds per process.
  The available production database connection budget, sizing, failover,
  backups, and restore procedure were not verified.
- Redis is mandatory for rate limits, OIDC transactions, and allocation
  coordination. The Redis client has no application-configured command
  deadline or explicit reconnect policy. Production Compose requires a Redis
  password and mounts `/data`, but does not configure a memory limit, eviction
  policy, TLS, or explicit AOF/RDB durability policy. The production image tag
  is `redis:7`; its exact deployed patch version is not pinned here.
- PostgreSQL is authoritative for sessions, users, roles, bookings, and
  allocation generations. Redis-only OIDC transactions, rate counters,
  presence, offers, and leases can be lost on Redis data loss; PostgreSQL
  assignment state is not itself stored in Redis.
- `/health` is liveness; `/ready` checks PostgreSQL and Redis. Both are
  excluded from rate limiting. The backend listens on `0.0.0.0`; its trust
  boundary depends on deployment network controls and `TRUST_PROXY`.
- The real Auth0 tenant, registered callbacks, TLS-terminating ingress,
  forwarded-header chain, cookie behavior behind that ingress, and provider
  token exchange were not available to verify. No load/benchmark scripts were
  found; no capacity or resource measurements were made.

### Multi-process and failure evidence

| Check | Result |
| ----- | ------ |
| Two live API processes share PostgreSQL sessions; a session issued on one authenticated on the other | PASS |
| Revocation on one process rejected the same session on the other | PASS; HTTP 401 |
| OIDC transaction started on one process was consumed on the other; replay was rejected | PASS; provider-error callback and replay both HTTP 401; no live Auth0 exchange |
| Redis fixed-window count shared across live processes despite differing spoofed `X-Forwarded-For` values with `TRUST_PROXY=false` | PASS; statuses 200, 200, 429; `Retry-After: 60` |
| Two independent service processes raced `startAllocation` and generation advance | PASS; exactly one start won and exactly one compare-and-set advanced generation 1 to 2 |
| Two independent service processes raced the Redis allocation lease | PASS; exactly one acquired the lease |
| Worker connected to replica B; presence and offer state written through replica A; worker accepted through replica B | PASS for shared presence/state and PostgreSQL assignment |
| Offer notification from replica A reached a worker socket connected to replica B | **FAIL**; no event was received. Socket.IO rooms are process-local because no cross-process Socket.IO adapter is configured. A worker may have a shared pending offer but not receive its push notification. |
| Redis network partition returned bounded errors for `/ready` and a rate-limited `/v1` request | **FAIL**; requests remained pending beyond 6 seconds and again beyond 11 seconds, then the external probes timed out. No local-counter fallback was observed. |
| PostgreSQL network partition caused a bounded `/ready` response | **FAIL**; the request remained pending beyond 8 seconds, then the external probe timed out. |
| Redis readiness after restoring its isolated container network connection | PASS; both backend processes returned ready without restart |
| PostgreSQL readiness after restoring its isolated container network connection | PASS; the probed backend process returned ready without restart |
| Direct forwarded-IP spoofing with `TRUST_PROXY=false` | PASS; the changing forged IPs shared the same rate-limit bucket, demonstrating that Fastify used the direct peer in this test |
| Actual TLS ingress, trusted proxy address/chain, cookie transport, Auth0 tenant, Redis restart/data loss, PostgreSQL restart/failover, graceful SIGTERM shutdown, expired-session behavior, recovery-worker overlap, and crash windows | NOT VERIFIED |
| Load, throughput, latency percentiles, CPU/memory, pool saturation, and production capacity | NOT VERIFIED; no load test was run |

The allocation and Socket.IO test used a real `socket.io-client`. The offer
was created through one API process and explicitly accepted by HTTP through
the other, demonstrating shared Redis/SQL state; it did **not** demonstrate a
usable real-time worker notification. This process-local event delivery is a
release blocker for multi-replica offer dispatch.

Network-partition probes disconnected only the A.10-created Redis or
PostgreSQL container from Docker's `bridge` network and reconnected that same
container afterward. The Redis commands were:

```text
docker network disconnect bridge pronto-a10-redis-2d1e02d5
docker network connect bridge pronto-a10-redis-2d1e02d5
```

The PostgreSQL probe used the corresponding
`pronto-a10-db-2d1e02d5` container. These were network interruptions, not
Redis data-loss, container restart, or failover tests. The timeout results
show that the current clients do not bound in-flight dependency operations in
these failure modes; production recovery must not be inferred from readiness
returning after network restoration.

### Migration correction and verification

To prevent multiple backend replicas from applying migrations concurrently,
`src/start.ts` holds a PostgreSQL session-level advisory lock while invoking
`drizzle-kit migrate`. The lock is released when the lock connection closes,
including on migration failure; the backend server is imported only after a
successful migration. This serializes the repository's normal startup path.
Calling `drizzle-kit migrate` directly bypasses that lock.

The two-process check used two separate `pnpm exec tsx src/start.ts` processes,
distinct HTTP ports, a new empty PostgreSQL database, and the same isolated
Redis service. Both `/ready` endpoints returned ready and the migration
journal contained 16 rows. A direct concurrent CLI run remains a negative
control, not an approved deployment procedure.

### Commands and final verification

The migration/startup checks used `pnpm exec drizzle-kit migrate` for a single
fresh-database migration and two simultaneous `pnpm exec tsx src/start.ts`
processes for the locked startup case. The live API checks used two independent
`pnpm exec tsx src/server.ts` processes with test-only environment settings.
PostgreSQL integration tests used the fresh migrated database; Redis
integration tests used separate logical databases on the isolated local Redis.

| Command/check | Result |
| ------------- | ------ |
| Fresh complete Drizzle migration chain | PASS; 16 migrations |
| Concurrent locked backend startup | PASS; 2 processes ready, 16 migrations |
| Concurrent direct migration CLI negative control | FAIL as a safe deployment procedure; one invocation exited nonzero |
| Focused A.3-A.9 authentication, session, rate-limit, booking, worker, allocation, and Socket.IO regressions | PASS; 25 files, 202 tests |
| Complete backend Vitest suite with PostgreSQL, OIDC Redis, rate-limit Redis, and admin-bootstrap integrations enabled | PASS; 30 files, 225 tests |
| `pnpm --filter backend exec tsc --noEmit` | PASS |
| `pnpm check-types` | PASS |
| `pnpm build` | PASS; backend, web, and docs |
| `pnpm --filter backend exec drizzle-kit check` | PASS |
| Production and development Compose `config --quiet` | PASS; configuration syntax only |
| `git diff --check` | PASS; line-ending warnings only |

Actual production Auth0/ingress deployment, Redis durability and eviction,
PostgreSQL backups/failover, cross-replica Socket.IO delivery, bounded
dependency-failure responses, and realistic load/resource measurements remain
unverified or failed as stated above.

**A.10 recommendation: NO-GO.** Do not operate the marketplace across
replicas until cross-process offer notifications are delivered, Redis and
PostgreSQL operations fail within explicit bounded deadlines, and the real
Auth0, ingress/TLS, persistence, and recovery topology is validated. The
migration startup lock is verified but does not mitigate those blockers.
