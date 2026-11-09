# Pronto+ Production Authentication Architecture

**Assessment date:** 2026-11-06  
**Status:** Auth0 is the approved identity provider for React Native mobile and
web clients. Milestones A.3–A.6 implement PostgreSQL identity mapping, Auth0
ID-token verification, authorization-code + PKCE, and PostgreSQL-backed
application sessions. Phone verification and onboarding remain unimplemented.

## 1. Executive recommendation

Auth0 is the approved identity provider for React Native mobile and web
clients. The provider authenticates people; PostgreSQL remains authoritative
for Pronto+ identity mapping, roles, account state, worker state, session
validity, and authorization. A.5 uses client callbacks followed by a backend
code exchange; A.6 creates a local server-managed session after the mapped user
has been confirmed active.

Auth0 tenant-region suitability, India SMS delivery and cost, and forecast
authentication budget remain deployment/procurement checks. This assessment
does not establish that Auth0 has an India tenant region.

**AWS Cognito is the strongest alternative if Pronto+ is deployed on AWS in
India.** AWS currently documents Cognito in Mumbai (`ap-south-1`) and Hyderabad
(`ap-south-2`). However, Cognito documents that required MFA is incompatible
with passwordless email/SMS OTP first factors in the same user pool. Meeting
both requested customer passwordless methods and mandatory administrator MFA
would likely require separate pools or a different customer sign-in policy.
That adds issuer, user-pool, and operational complexity.

Clerk offers a convenient developer experience and the required identity
methods at paid tiers, but its documented primary integration is Clerk-managed
sessions and SDKs. Whether its exact offering meets this project's desired
generic OIDC BFF callback contract, deployment-region needs, and India SMS
economics must be confirmed. Clerk's current pricing page states that SMS
authentication is paid and international SMS is at market rate.

This architecture is not a production-readiness certification. The provider
and client-scope decisions are approved; the remaining policies in §11 still
require resolution before their corresponding login/session implementations.

## 2. Existing repository architecture

### Authentication

- [`session-auth.ts`](../backend/src/plugins/session-auth.ts) decorates
  Fastify with `app.authenticate`, `app.requireWorker`, and
  `app.requireAvailableWorker`. It verifies application credentials against
  PostgreSQL and obtains the current local role and account state.
- [`session.service.ts`](../backend/src/modules/sessions/session.service.ts)
  creates cryptographically random session credentials and persists only a
  SHA-256 verifier; it does not store provider tokens.
- [`auth.types.ts`](../backend/src/modules/auth/auth.types.ts) defines the
  current local request identity as `{ userId, role }`; role is loaded from
  PostgreSQL rather than a client/provider claim.
- [`auth.routes.ts`](../backend/src/modules/auth/auth.routes.ts) exposes
  Auth0 transaction/callback routes, logout, session revocation, and CSRF-token
  renewal. `POST /v1/auth/test-token` exists only in test mode and creates a
  native session for an existing active local user; it is not production
  authentication.

### Local users and worker state

- [`users.ts`](../backend/src/db/schema/users.ts) stores a required unique
  `phoneNumber`, name, nullable email, local role, `isActive`, and timestamps.
  Email is not unique. Identity mappings are stored separately in
  `auth_identities`; sessions are stored in `app_sessions`. There are no
  phone-verification flags or local password hashes.
- [`workerProfiles.ts`](../backend/src/db/schema/workerProfiles.ts) stores
  worker data and operational status (`offline`, `available`, `busy`,
  `suspended`), plus soft deletion. The schema's `userId` is unique but is not
  declared as a Drizzle foreign key to `users`.
- [`users.repository.ts`](../backend/src/modules/users/users.repository.ts)
  creates users and looks them up by phone or ID. It does not check `isActive`
  during authentication.
- [`workers.repository.ts`](../backend/src/modules/workers/workers.repository.ts)
  can find and update worker profiles and status, but it does not participate
  in request authentication.
- [`users.routes.ts`](../backend/src/modules/users/users.routes.ts) permits
  user creation only to an authenticated admin. Its create schema allows
  `customer` or `worker`, not `admin`.
- [`workers.routes.ts`](../backend/src/modules/workers/workers.routes.ts)
  restricts profile creation to admins, allows owners to update only bio, and
  permits admin status updates. There is no public worker application or
  explicit approval-state model.

### Authorization, sessions, and Socket.IO

- Existing route-level role and ownership checks should be preserved. In
  particular, booking owner/assigned-worker checks in
  [`bookings.routes.ts`](../backend/src/modules/bookings/bookings.routes.ts)
  must not be replaced by provider claims.
- [`socket.ts`](../backend/src/realtime/socket.ts) authenticates the same
  PostgreSQL-backed application session, checks local worker eligibility, and
  revalidates each event plus every 15 seconds while connected. Forwarded TLS
  is accepted only from a configured trusted proxy peer/hop.
- [`worker-socket.ts`](../backend/src/realtime/worker-socket.ts) gates worker
  behavior by current local role and profile; operational status updates do
  not override suspension.
- [`env.ts`](../backend/src/config/env.ts) validates session TTL, exact trusted
  web origins, and Auth0 issuer/client/redirect settings.
- [`app.ts`](../backend/src/app.ts) registers cookie parsing, exact-origin
  credentialed CORS, session authentication, and Fastify rate limits.
- [`redis.ts`](../backend/src/config/redis.ts) provides a shared Redis client
  used for presence and allocation coordination. The approved direction keeps
  PostgreSQL authoritative for session validity. Redis coordinates login
  transactions but does not cache session validity.
- [`start.ts`](../backend/src/start.ts) runs Drizzle migrations before loading
  the server. New schema migrations should follow that existing startup
  behavior.
- Migrations are SQL files under `backend/src/db/migrations/`, with Drizzle
  journal/snapshot metadata. Migration 0012 adds identity mapping and 0013
  adds application sessions.
- Tests use Vitest. `backend/vitest.config.ts` sets `NODE_ENV=test`, loads
  optional test environment configuration, and `vitest.setup.ts` can initialize
  the test schema unless `SKIP_TEST_DB_SETUP=1`. A.4 adds local-JWKS ID-token
  verification tests. Local Auth0/session boundaries have focused automated
  tests; real-tenant behavior and refresh-token rotation (not implemented)
  have not been tested.

### Immediate consequences

1. A.3 provides the internal mapping repository/service, A.4 verifies Auth0
   ID tokens, A.5 verifies the authorization-code transaction, and A.6 creates
   an application session for a mapped active local account. No public linking
   flow exists.
2. `phoneNumber` is required and unique for all local users; email is nullable
   and non-unique. The approved customer and worker phone requirement is
   preserved. Phone ownership verification before activation/onboarding is
   required by policy but is not implemented in this milestone.
3. Every protected HTTP request checks session revocation/expiry and current
   active state and role in PostgreSQL. Worker access additionally checks the
   current profile and suspension state.
4. No JWT role claim or Auth0 role claim is used for Pronto+ authorization.
5. A.5 alone returned identity verification only; A.6 adds a distinct local
   session credential through web-cookie or native-bearer transport.

## 3. Provider comparison

The comparison uses each provider's public documentation and public pricing
page as retrieved on 2026-11-06. Prices are vendor-listed USD examples, before
tax, SMS delivery charges, negotiated discounts, and any deployment-specific
costs. Recheck before procurement.

| Requirement                  | Auth0                                                                                                                            | Amazon Cognito                                                                                                              | Clerk                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization code + PKCE    | Documented authorization-code/PKCE flow; hosted Universal Login                                                                  | `/oauth2/authorize` and code flow; supports state, nonce, and PKCE parameters                                               | Primary docs emphasize Clerk SDK-managed sign-in/session tokens. Generic external OIDC callback fit should be confirmed before selection. |
| Email sign-in                | Passwordless email OTP/link documented                                                                                           | Email verification and email OTP support depend on configured pool features                                                 | Email code and link documented                                                                                                            |
| Phone sign-in                | Passwordless SMS OTP documented                                                                                                  | Phone OTP and phone verification documented; uses SNS                                                                       | Phone OTP documented; production requires paid plan and country SMS allowlist                                                             |
| Email/phone verification     | Provider verification workflows documented                                                                                       | Provider verification workflows documented                                                                                  | Verification flows documented                                                                                                             |
| Administrator MFA            | MFA factors documented; selective policy can be implemented with provider flow/actions, subject to chosen plan and configuration | TOTP/SMS/email MFA supported for local users, but required MFA cannot coexist with passwordless OTP first factors in a pool | MFA is a paid-plan feature; per-role enforcement and the desired BFF behavior need validation                                             |
| Backend token verification   | RS256/JWKS documented; validate issuer, audience, signature, and claims                                                          | RS256 user-pool JWTs and JWKS documented; verify ID/access tokens independently                                             | `verifyToken`/`authenticateRequest`, issuer/audience/JWKS options documented                                                              |
| Stable identity key          | `(iss, sub)`; connection changes/account linking require controlled mapping                                                      | Pool-scoped `sub`; pool migration means new issuer/subject mappings must be planned                                         | Instance-scoped subject/user ID; instance migration requires mapping                                                                      |
| India deployment region      | Must confirm available tenant/data-residency region; no India region is asserted here                                            | Official endpoint list includes Mumbai `ap-south-1` and Hyderabad `ap-south-2`                                              | India hosting/data-residency region not established by reviewed docs                                                                      |
| India SMS                    | Depends on configured delivery route and contract; quote required                                                                | SNS pricing, country delivery constraints, sender registration, and account readiness apply                                 | International SMS is listed as market rate; India must be enabled in the SMS allowlist                                                    |
| Main operational cost driver | MAU tier, plan/MFA features, and SMS provider charges                                                                            | MAU feature tier plus SNS SMS and SES email charges; AWS setup and operations                                               | MRU tier plus paid SMS; MRU is not equivalent to MAU                                                                                      |
| Main lock-in                 | Tenant/connection-specific subject and Actions; migration needs subject mapping                                                  | AWS user-pool issuer, `sub`, pool settings, Lambda triggers, and AWS SMS/email integration                                  | Clerk instance IDs, APIs, SDKs, and session model                                                                                         |
| Fit for selected OIDC flow   | Strong                                                                                                                           | Strong OIDC fit, with admin/customer MFA-flow constraint                                                                    | Less clear unless exchange from Clerk session into local app session is explicitly approved                                               |

### Public pricing comparison

#### Auth0

The current public B2C pricing page lists Essentials from **$35/month** and
Professional from **$240/month**. Published monthly tier examples include:

| MAU tier |   Essentials |                 Professional |
| -------: | -----------: | ---------------------------: |
|      500 |    $35/month |                   $240/month |
|    5,000 |   $350/month |                 $1,000/month |
|   10,000 |   $700/month |                 $1,600/month |
|   30,000 | $2,100/month |                Contact sales |
|   50,000 | $3,500/month | Not available at listed tier |

Auth0 notes that usage between listed MAU tiers bills at the next tier up.
Essentials currently lists Pro MFA; Professional lists Enterprise MFA and
enhanced attack protection. Do not infer the India SMS delivery price from
these plan prices; the delivery route and message charges need a quote.

#### Amazon Cognito

The current Cognito pricing page distinguishes Lite, Essentials, and Plus
feature tiers. Its Essentials example for direct/local user-pool sign-ins
includes 10,000 MAUs and prices additional usage at **$0.015/MAU** in the
published example. This implies approximately **$1,350/month at 100,000
direct MAUs** under that example's tier assumptions (90,000 x $0.015), before
SMS, email, or optional security-feature charges. Plus pricing is shown as
$0.020/MAU in a published example and has no free MAU allowance in that
example. Eligibility for any legacy free tier differs by account and pool
history; do not budget on an undocumented carryover.

Cognito charges separately for SMS through SNS and email through SES.
SMS delivery cost varies by destination and sender route and must be estimated
from the official SNS price table for expected countries.

#### Clerk

The current pricing page lists Hobby at no charge with a **50,000 MRU/app**
limit and Pro at **$25/month** (or **$20/month billed annually**) with 50,000
MRUs included; additional MRUs are listed at $0.02 each. Pro is also the tier
that includes MFA and production SMS authentication. The pricing page lists
international SMS at “market rate.” The phone sign-in guide states that only
US and Canada are enabled by default on the SMS allowlist. MRUs count retained
users and must not be treated as MAUs for direct comparison.

### Provider assessment

**Auth0 — selected provider.** It supplies hosted OIDC-oriented flows,
email/SMS passwordless, JWKS-verifiable tokens, and MFA controls without
requiring Pronto+ to own OTP delivery or password recovery. Concerns are
potentially material MAU-tier cost, external SMS delivery costs, and the
unconfirmed tenant-region fit for the actual deployment/data-residency policy.

**Cognito — best regional fit if AWS is selected.** Cognito has documented
Mumbai and Hyderabad endpoints, native OIDC endpoints, local user-pool
identities, and AWS-native email/SMS delivery. The key design issue is its
documented incompatibility between required MFA and email/SMS passwordless
first factors in the same user pool. A second privileged-user pool or a
different customer authentication policy would be needed. That is a real
architecture tradeoff, not a reason to silently weaken administrator MFA.

**Clerk — convenient but confirm protocol and geography.** Its price and
prebuilt authentication capabilities can suit a web product, and it supports
email and phone verification. However, the reviewed official documentation is
centered on Clerk session JWTs and framework SDKs; it does not establish that
the desired direct authorization-code callback/BFF exchange is the intended
integration. India SMS pricing and data-residency details also need written
confirmation.

## 4. OIDC verification and authorization-code flow

### Selected integration boundary: client callback, backend exchange (A.5)

Web and React Native clients receive the Auth0 authorization URL, complete
Universal Login, and receive the one-use code at their exact registered
callback URI. The client then POSTs only `state` and `code` to the backend. The
backend—not either client—owns the PKCE verifier, exchanges the code, verifies
the ID token, and resolves the local identity. A.6 additionally creates a local
session for a mapped active user after verifying the initiating-client context.

This is not a confidential-client BFF: web and native Auth0 registrations are
separate public clients and no client secret is used. It avoids embedding a
secret in the native application and avoids embedding provider tokens in
either client. A.6 binds session creation to the initiating browser/app context
and adds login-CSRF protection.

#### Transaction lifecycle

1. `POST /v1/auth/oidc/transactions` accepts only `clientType` (`web` or
   `native`) and an exact `redirectUri` present in that client's configured
   allowlist. It rejects unknown client types and redirects.
2. The backend generates independent 256-bit random `state`, `nonce`, and
   PKCE `code_verifier` values using Node's cryptographic random source. It
   sends only the `S256` code challenge, `state`, `nonce`, public client ID,
   exact redirect URI, `response_type=code`, and `scope=openid` to Auth0.
3. The transaction is stored in the shared Redis service for 600 seconds under
   a SHA-256 digest of `state`. Redis stores the exact client registration,
   redirect URI, nonce, verifier, and timestamps; the state itself is not
   stored as a key or in the transaction payload. Redis TTL removes abandoned
   records.
4. Auth0 returns `code` and `state` to the registered web HTTPS callback or
   native callback URI. The web initiation response sets a short-lived,
   state-scoped Secure/HttpOnly context cookie; native receives a random
   transaction binding that it must retain and submit at callback. The client
   POSTs `code` and `state` to `POST /v1/auth/oidc/callback`; native also sends
   its binding, while the browser sends its cookie. The backend atomically
   GET+DELs the transaction
   with one Redis Lua operation before processing it. Concurrent or replayed
   callbacks cannot both consume the same transaction. Expired, unknown,
   malformed, or client/redirect configuration-mismatched transactions fail
   closed.
5. The backend exchanges the code over TLS at the fixed `/oauth/token`
   endpoint under the configured issuer, with the transaction's exact
   `client_id`, `redirect_uri`, and PKCE verifier. Redirects at the token
   endpoint are rejected. Network or JWKS unavailability returns a generic
   temporary-unavailable response; other provider and invalid-token errors
   return generic authentication failures. Neither authorization code nor
   provider token is logged or returned. Provider access/refresh tokens are
   not persisted.
6. A.4 verifies the returned ID token against the configured issuer's fixed
   JWKS endpoint, RS256, expiry, not-before, issued-at age, nonce, and the
   transaction's exact client audience (including `azp` for multiple
   audiences). A.3 then resolves only the exact `(issuer, subject)` mapping.
7. An unlinked identity is rejected; no account is created or linked. An
   inactive local account is rejected. A.5 returned only a verification result;
   A.6 now creates a local session only after the backend confirms a linked,
   active user and the transaction's client-context binding.

Redis outages fail login closed. The atomic operation is shared across backend
replicas. Redis failover durability/replay behavior has not been tested; this
must be verified against the production Redis topology. At the A.6 checkpoint,
route limits still used Fastify's process-local store; A.9 replaces that
mechanism with the shared Redis policies described in section 9. Web callback
URLs must use HTTPS. Native callbacks may use an exact
registered custom scheme or HTTPS universal/app link. Production start and
exchange requests are rejected unless Fastify identifies the request as HTTPS;
configure `TRUST_PROXY` for the actual TLS-terminating ingress, never as
unrestricted `true`.

#### Auth0 application and environment configuration

Create two Auth0 applications: a web SPA/public client and a native/public
client for React Native. Enable Authorization Code with PKCE (`S256`) for both.
Register the exact web callback URL and native scheme/universal link in the
matching Auth0 application callback allowlist. Do not enable implicit or
resource-owner password grants for this flow. The backend uses no client
secret, API audience, or offline-access scope.

Production requires these exact settings:

- `AUTH0_ISSUER`: exact HTTPS issuer ending in `/`.
- `AUTH0_CLIENT_IDS`: comma-separated pair matching the two client IDs below.
- `AUTH0_WEB_CLIENT_ID` and `AUTH0_NATIVE_CLIENT_ID`: distinct Auth0 IDs.
- `AUTH0_WEB_REDIRECT_URIS`: comma-separated exact HTTPS web callback URLs.
- `AUTH0_NATIVE_REDIRECT_URIS`: comma-separated exact HTTPS app links or
  registered native custom-scheme callbacks.

Each redirect URI must be explicitly configured in the corresponding Auth0
application. Wildcards, placeholders, caller-controlled client IDs, and
unlisted redirects are rejected. Illustrative non-production values are shown
in the environment examples; replace them with actual registrations before
deployment. No production Auth0 tenant or client registrations have been
verified.

#### A.4 Auth0 ID-token verification (implemented)

- The verifier accepts only `RS256`, exact configured HTTPS issuer,
  allowlisted audience, non-empty subject, `exp`, `iat`, and exact transaction
  nonce. When used by A.5, it additionally requires the audience and `azp` to
  match the client selected when the transaction was created.
- It rejects expired/not-yet-valid tokens and tokens more than 10 minutes old,
  allowing five seconds of clock tolerance.
- JWKS URL is fixed to `/.well-known/jwks.json` under the issuer. `jose`
  caches keys for up to 10 minutes and limits unknown-key refreshes to once per
  30 seconds; provider failures fail closed.
- The result contains only verified identity and optional contact claims.
  Roles, permissions, raw tokens, and unrelated provider claims are omitted.
  Contact claims are not identity keys or evidence of Pronto+ phone
  verification.

#### Authorization and session boundary (A.6)

A.5 identity resolution alone does not grant application access. A.6 creates
a PostgreSQL-backed local session only after exact identity mapping and an
active local-user check. It does not create users, auto-link contacts, activate
accounts, verify phone ownership, or grant roles. Every protected HTTP request
re-reads session validity and current local account/role state. Worker-only
actions additionally require a non-deleted, non-suspended worker profile;
acceptance actions require operational status `available`.

At the A.6 checkpoint, the worker schema had no approval-state field. A.7
adds a separate approval lifecycle below; phone ownership verification and
onboarding remain unimplemented, and required phone values do not prove
ownership.

## 5. PostgreSQL data model

The `auth_identities` table and
[`0012_spotty_blur.sql`](../backend/src/db/migrations/0012_spotty_blur.sql)
are implemented in Milestone A.3. The `app_sessions` table is implemented in
A.6; refresh-token history remains unimplemented.

### `auth_identities` (implemented)

| Column                                          | Purpose                                   |
| ----------------------------------------------- | ----------------------------------------- |
| `id` serial primary key                         | Internal mapping ID, following `users.id` |
| `user_id` integer not null FK to `users.id`     | Local user                                |
| `issuer` text not null                          | Exact validated OIDC issuer string        |
| `subject` text not null                         | Exact OIDC subject string                 |
| `created_at`, `updated_at` timestamptz not null | Mapping lifecycle                         |

`user_id` references `users.id` with `ON DELETE CASCADE`. Unique indexes
enforce `(issuer, subject)` globally and `user_id` individually. They support
identity lookup and local-user lookup, and enforce one primary external
identity per local user. No email, phone, provider token, or client secret is
stored in this table.

#### Identity lookup and linking contract

- Lookup is an exact `(issuer, subject)` match. Neither value is normalized;
  the subject is not lowercased or rewritten.
- An unknown identity returns an explicit `not_linked` result. Lookup does not
  create a user, grant a role, or change account or worker status.
- Linking is an internal operation only. It requires an authenticated self-link
  context or an authorized administrator context supplied by a future trusted
  authentication/authorization boundary, plus an explicitly selected local
  user. No public linking endpoint is part of A.3.
- Linking runs in a database transaction, locks the target user row, and relies
  on unique indexes to reject concurrent duplicate identity or user mappings.
- Linking never reassigns an existing identity. Existing identity ownership
  and a user's existing primary identity produce explicit conflicts.
- Issuer and subject must come from a future trusted OIDC verification
  boundary. A caller-supplied user ID alone is not authorization. A mapping is
  not proof of phone ownership and does not activate a customer or worker.
- Existing users receive no mapping during migration. There is no backfill and
  no ownership inference from email or phone equality.
- `users.phone_number` remains required. Verified-phone enforcement before
  account activation/onboarding remains a later milestone.

### Contact attributes on `users` (current schema)

The current schema requires a unique `phone_number`; email is nullable and
non-unique. This preserves the approved required-phone policy for customers
and workers. Phone verification before activation/onboarding is required by
policy but is not implemented by A.3. No verification flag is added without a
defined verification flow.

Keep local `role` and `is_active` in PostgreSQL. Provider metadata is not the
authorization database.

### `app_sessions` (implemented in A.6)

| Column                                      | Purpose                                       |
| ------------------------------------------- | --------------------------------------------- |
| `id` UUID primary key                       | Non-guessable session identifier              |
| `user_id` integer FK to users                | Owning local identity                         |
| `client_type` enum (`web`, `native`)         | Enforces distinct credential transports       |
| `token_hash` fixed-length text, unique       | SHA-256 verifier of the random session secret |
| `csrf_token_hash` nullable fixed-length text | Web CSRF verifier; no raw CSRF token at rest   |
| `created_at`, `expires_at`, `last_used_at`   | Session lifecycle                             |
| `revoked_at` nullable                       | Durable revocation                            |

The foreign key cascades on local-user deletion. The token hash is uniquely
indexed; indexes also support user session lookup and expiry cleanup. A
credential is `uuid.base64url-secret`; the secret is 32 cryptographically
random bytes and only its SHA-256 hash is stored. The default
`APP_SESSION_TTL_SECONDS` is 3600 seconds (one hour), configurable from 300 to
86400 seconds. The one-hour default limits the useful lifetime of a stolen
bearer credential while avoiding frequent reauthentication during a typical
work session; without refresh, clients must reauthenticate after expiry. There
is no refresh-token table or refresh-token flow.

Sessions are checked directly in PostgreSQL on each protected HTTP request;
there is no Redis session-validity cache. Revocation, local account
deactivation, role changes, and worker suspension therefore apply on the next
authorization check after the database commit. In-flight operations already
authorized before the change may complete.

### `refresh_tokens` (not implemented)

One row per rotated opaque token, retained until the associated session/token
family expiry so reuse can be detected.

| Column                                                    | Purpose                                              |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `token_hash` bytea or fixed-length hex primary/unique key | Hash/HMAC of random token; never store the raw token |
| `session_id` UUID FK to app_sessions                      | Session/token family                                 |
| `issued_at`, `expires_at` timestamptz                     | Token validity                                       |
| `consumed_at` timestamptz nullable                        | Rotation state                                       |
| `replaced_by_hash` nullable                               | Rotation audit linkage                               |

Unique `token_hash`; index `(session_id, issued_at)` and expiry. Tokens must be
cryptographically random, high entropy, and only returned once in a secure
cookie.

### Refresh transaction and replay

1. Hash the presented opaque token; begin a transaction.
2. Lock the owning session row (`FOR UPDATE`) and refresh-token row.
3. Check session is active, user remains active, token is not expired, and token
   is unconsumed.
4. Mark old token consumed, insert the replacement hash, and update session
   last-used time atomically.
5. Commit before returning the new cookie.
6. If a previously consumed token is presented, revoke the session and all
   still-valid refresh credentials in the same transaction, then return a
   generic reauthentication response. Do not log the token.

Concurrent legitimate refresh requests must be serialized. The browser client
should single-flight refresh. A race in which the caller loses the response
after commit may force reauthentication; do not introduce a replay grace
window without an explicit threat analysis and idempotent response design.

### Audit events

Add a durable append-only `auth_audit_events` table for local security
decisions that provider logs do not fully cover:

- Admin role grants/removals and worker approvals.
- Identity link/unlink.
- Account activation/suspension.
- Session revoke and refresh-token reuse.
- Provider login success/failure categories (never raw tokens or secrets).

Use generated event ID, event timestamp, actor user ID nullable, target user
ID nullable, action enum/string, request/correlation ID, and minimal
non-sensitive metadata. Add indexes by `(target_user_id, created_at DESC)` and
`(action, created_at DESC)`. Retention, export, and tamper-resistance policy
must be approved; avoid logging raw IP or user agent unless justified.

## 6. API contract and remaining session proposals

### Implemented OIDC transaction and callback

- `POST /v1/auth/oidc/transactions` accepts `{ clientType, redirectUri }`,
  where `clientType` is `web` or `native` and the URI is an exact configured
  allowlist entry. It returns an Auth0 `authorizationUrl` and transaction
  expiry. It does not accept a client ID, user ID, role, account state, or
  post-login destination.
- `POST /v1/auth/oidc/callback` accepts exactly one of `{ state, code }` or
  `{ state, error }`. The callback must include the state received in the Auth0
  redirect and the context binding from the initiating client. It creates a
  local session only for an active linked user; failures are returned as
  generic authentication errors.
- Request bodies are bounded; rate limits use the existing Fastify mechanism.
  Provider tokens, local user IDs, and roles are never returned. Authorization
  codes are not stored and are exchanged only after single-use transaction
  consumption. Web receives an HttpOnly cookie and a CSRF token; native
  receives the local app-session credential only.
- Clients must remove callback query values from browser history promptly and
  POST the code/state only over HTTPS. Provider tokens are never returned.
- Never accept arbitrary return destinations or a caller-provided identity,
  audience, client ID, issuer, or local user ID.

### Current user and session lifecycle

- `POST /v1/auth/logout` — revokes the presented web or native session
  credential idempotently and clears the web cookie.
- `POST /v1/auth/sessions/revoke` — revokes all sessions owned by the
  authenticated local user.
- `GET /v1/auth/sessions/csrf` — rotates and returns a web CSRF token; native
  sessions receive no CSRF token.
- No refresh-token or session-list endpoint exists. Expired clients must
  reauthenticate.

### Customer onboarding

- A local customer must have a phone number, and phone ownership must be
  verified before account activation/onboarding. Those checks and account
  creation are deferred; a provider identity mapping alone does not provision
  or activate the customer.
- If an identity matches an existing local contact, do not auto-link solely on
  matching contact value. Require proof of the existing account or assisted
  linking.
- Any future customer onboarding route may collect profile data only after the
  required phone verification and cannot set role from client/provider input.
- Contact and account enumeration responses must be generic.

### Worker onboarding and administrator provisioning

- `POST /v1/workers/onboarding` creates a request associated with the
  authenticated user with required, verified phone ownership; it does not grant
  worker role or an active worker profile.
- `POST /v1/admin/worker-onboarding/:requestId/approve` is admin-only and
  audited. Approval creates/activates worker profile and grants local worker
  role atomically.
- `POST /v1/admin/users/:userId/suspend` and an audited reactivation route
  control local account state.
- No public administrator registration endpoint.
- Bootstrap first administrator through an audited, restricted operational
  procedure (e.g. one-time deployment command) with provider identity mapping
  and enforced MFA. Do not add a permanent backdoor or shared admin token.

## 7. Security enforcement requirements

### OIDC and token validation

- Exact issuer and audience allowlists per configured environment.
- Signature validation using provider JWKS and an explicit allowlist (normally
  RS256 where provider supports it); reject `none`, unexpected algorithms,
  wrong `kid`, invalid signature, missing claims, expired or not-yet-valid
  tokens.
- Validate nonce against one-time server-side transaction state.
- Enforce PKCE S256 and one-use authorization codes.
- Maintain a bounded JWKS cache with safe unknown-`kid` refresh, backoff, and
  stale-key behavior. Do not fetch JWKS on every request.
- OIDC `state`, exact registered callback URIs, secure cookies, allowlisted
  post-login redirects, and CSRF defenses are mandatory.
- Provider outages should fail closed for new login. Existing local sessions
  may continue according to their app-session policy.

### Local account and role enforcement

- Resolve local user by `(issuer, subject)`.
- Read `users.is_active` and role from PostgreSQL; never derive application
  privileges from client input or untrusted provider custom metadata.
- Inactive users are rejected even if their provider account still logs in.
- Worker access additionally requires active local worker role, an existing
  non-deleted worker profile, and status other than `suspended`. The schema
  has no explicit approval state; profile existence currently reflects
  admin-only provisioning. Availability is required for operations that accept
  new work.
- Preserve all existing route-level ownership checks and booking state
  transitions.
- A provider identity being verified does not approve a user to become a
  worker or administrator.

### Sessions and revocation guarantee

**Implemented HTTP guarantee:** session revocation, user deactivation, role
changes, and worker suspension take effect on the next authorization check
after the PostgreSQL transaction commits. Requests already authorized before
that commit can finish; authentication cannot undo an operation already in
flight.

Each protected HTTP request checks PostgreSQL for:

- Session exists, not revoked, and not expired.
- User is active and local role is current.
- Worker profile exists and is not deleted/suspended for worker actions.

This adds a database lookup per protected request. No Redis session cache is
used. Redis outages do not change validity of an existing PostgreSQL session;
new login transaction operations fail closed when transaction Redis is
unavailable.
If PostgreSQL is unavailable for that authorization check, protected requests
and privileged socket events fail closed.

Socket.IO authenticates at connection, revalidates each event, and also checks
session/account/role/worker status every 15 seconds while idle. Thus an idle
socket is disconnected on the next revalidation (nominally within 15 seconds,
plus database/network scheduling). There is no shared Socket.IO adapter;
cross-replica disconnect is not immediate, but protected events revalidate
against PostgreSQL before processing.

### Refresh, cookies, logs, and test isolation

- Refresh-token rotation is not implemented; expiration requires reauthentication.
- Web uses a host-only `__Secure-pronto_session` cookie with `Secure`,
  `HttpOnly`, `SameSite=None`, `Path=/v1`, and explicit expiry. State-changing
  cookie-authenticated requests require exact trusted Origin and a matching
  `X-CSRF-Token`. CORS credentials are limited to exact configured web origins.
- Native receives the local bearer credential only over HTTPS and must store it
  using platform secure storage, not ordinary unencrypted preferences. Native
  requests use Authorization only; cookie/bearer mixing is rejected.
- Web login initiation sets a short-lived Secure/HttpOnly context cookie scoped
  to `/v1/auth/oidc`; native receives a random context binding that must be
  retained securely and returned at callback. Both bindings are transaction-
  specific and checked before session creation. This prevents a callback from
  another browser/app context from consuming the transaction.
- Use generic external authentication errors. Do not reveal whether arbitrary
  phone/email values exist.
- Never log authorization headers, cookies, provider codes/tokens, refresh
  tokens, client secrets, or full credential-bearing URLs.
- The test-only token route exists only when `NODE_ENV === "test"` and creates
  a session only for an existing active user. Production does not issue JWTs.

## 8. Implementation roadmap

Each milestone is reviewable independently. Auth0 and the web/native client
scope are approved; actual tenant registration and production rollout remain
deployment prerequisites.

### Milestone 1 — Provider decision and threat model

**Files:** this document; deployment/operations decision record.

**Decisions:** provider, region, browser vs mobile scope, email/phone UX,
administrator MFA requirement, provider outage policy, login and linking
policy, session revocation SLO, budget.

**Acceptance:** signed-off provider architecture; verified tenant region and
India SMS quote; staging/test separation and admin MFA policy documented.

### Milestone 2 — Schema and migration

**Status:** Identity mapping is implemented in A.3 and durable sessions in A.6.
Refresh-token history and durable authentication audit events remain future
work.

**Implemented files:**

- `backend/src/db/schema/authIdentities.ts`
- `backend/src/modules/auth-identities/identity.repository.ts`
- `backend/src/modules/auth-identities/identity-mapping.service.ts`
- migration 0012 and its snapshot/journal entry

Existing user phone requirements and worker state were preserved; no identity
mapping is inferred for existing users.

**Deferred after A.6:** refresh-token history, audit events, contact
verification, and explicit onboarding/worker approval models.

### Milestone 3 — OIDC transaction and verifier adapter (A.4/A.5 implemented)

**Implemented files:**

- `backend/src/modules/auth/auth0-id-token-verifier.ts`
- `backend/src/modules/auth/auth0-identity.service.ts`
- `backend/src/modules/auth/auth0-login-transaction.ts`
- `backend/src/modules/auth/auth0-authorization-code-flow.ts`
- `backend/src/modules/auth/auth.routes.ts`
- `backend/src/config/env.ts`
- local signing-key/JWKS and flow/route tests

The implementation uses the existing `jose`, Redis, Fastify, and rate-limit
dependencies. Redis stores short-lived hashed-state transactions and
atomically consumes them across backend replicas.

**Verified locally:** generated RS256 keys/local JWKS, PKCE S256 construction,
exact web/native allowlists, transaction expiry/replay, and generic failures.
Real Auth0 configuration and production Redis failover remain NOT VERIFIED.

### Milestone 4 — Onboarding and local authorization policy

Identity lookup/mapping exists in A.3 and is used by A.5. A.6 implements local
session issuance and request authorization; user provisioning, phone
verification, public account linking, and worker onboarding remain deferred.
At that milestone checkpoint, no approval state existed; A.7 implements it
separately from profile existence and operational availability.

### Milestone A.6 — Local application sessions and authorization (implemented)

**Implemented files:** `backend/src/db/schema/appSessions.ts`, migration 0013
and snapshot/journal, `backend/src/modules/sessions/`, session-auth plugin,
Auth0 callback/context-binding updates, worker/booking/socket authorization,
and focused unit/integration tests.

**Behavior:** creates a random opaque session credential after A.3/A.4/A.5
success; stores only its SHA-256 verifier in PostgreSQL; uses an HttpOnly web
cookie plus CSRF validation or a native HTTPS bearer credential; revokes
sessions durably; and reads current local user/role/worker state from
PostgreSQL. Login callbacks are bound to the initiating browser via a
transaction cookie or to the native transaction via a client-retained random
binding. No refresh flow or provider token storage/return was added.

**Guarantee:** HTTP revocation and account/role state changes take effect on
the next PostgreSQL-backed authorization check. Socket.IO revalidates every
event and every 15 seconds while idle; network/database scheduling can extend
that nominal idle bound.

### Milestone A.7 — Worker approval lifecycle

Worker approval is stored independently from operational status in
`worker_profiles.approval_status` (`pending`, `approved`, `rejected`). The
forward-only migration adds the column with a `pending` default, so existing
worker profiles are preserved but none are implicitly approved. The migration
does not modify bookings. Operational `status` continues to represent
`offline`, `available`, `busy`, or `suspended`; suspension is not duplicated
in the approval enum.

Only an authenticated local administrator may use
`POST /v1/workers/:id/approval`. The request accepts only `approved` or
`rejected`; profile creation and update payloads cannot set approval. The
decision is made under a PostgreSQL row lock and records the administrator
and timestamp. Identical repeated decisions are idempotent. Allowed changes
are `pending -> approved`, `pending -> rejected`, and `approved -> rejected`.
Rejection is terminal in this milestone; a rejected worker needs a separately
authorized operational recovery process before any future re-approval policy
is introduced. A worker cannot decide their own profile.

Approval is required in allocation candidate selection, manual offer creation,
the final PostgreSQL booking-assignment update, worker HTTP authorization, and
worker Socket.IO authorization. Setting operational status to `available`
does not grant eligibility. HTTP authorization reads PostgreSQL on each
request. Socket.IO checks approval at connection and for each inbound event,
and rechecks idle connections every 15 seconds; a scheduling/network delay can
extend that nominal idle bound.

When approval is rejected, the service revokes that worker's outstanding
Redis offers. A Redis revocation failure is reported as unavailable; the
PostgreSQL approval change remains committed and is independently enforced by
the acceptance and assignment gates. Existing accepted, assigned, and
in-progress bookings are not automatically canceled or reassigned. Their
booking state remains unchanged; the worker's subsequent approval-gated
operational actions and Socket.IO authorization are denied. A separate
administrator workflow must resolve any active work safely.

The existing worker profile decision fields provide the deciding local user
and timestamp. A.8 adds a dedicated append-only-through-the-application audit
table and an offline first-administrator bootstrap command. Worker creation
remains an administrator operation. Phone numbers remain required but have no
verified ownership state; approval does not prove phone ownership and does not
replace the outstanding phone-verification/onboarding requirement.

### Milestone A.8 — First administrator and worker approval audit

#### One-time first-administrator bootstrap

There is no public bootstrap route. The operational command is
`backend/src/scripts/bootstrap-admin.ts`; it requires
`ADMIN_BOOTSTRAP_SECRET` in the one-off command environment and accepts only
an existing local user ID as its argument. The secret must be exactly 32
cryptographically random bytes encoded as unpadded base64url (43 characters).
The command never accepts a role, creates no user, and only promotes an active
local `customer` with an existing Auth0 identity mapping. The deployment
operator must identify the account out of band and verify the intended person
and linked Auth0 identity before running it. Phone ownership must be verified
through the separately approved process; the application has no phone
verification state.

Migration 0015 creates the singleton `admin_bootstrap_state` row. The command
locks that row in PostgreSQL, checks that bootstrap is unused and that no
administrator exists, then promotes the selected account and records
completion in the same transaction. Concurrent command attempts serialize
across replicas. If an administrator already exists, the command closes the
bootstrap marker without changing any user. A completed marker is permanent;
demoting or removing the first administrator does not re-enable bootstrap.
There is no reset or automatic admin recreation operation.

Production procedure:

1. Apply migrations through 0015. Provision an active local customer through
   the approved operational process and confirm it has exactly one linked
   Auth0 identity. Independently confirm the operator-selected account and
   identity; do not use a client-supplied role or contact match as proof.
2. Generate 32 random bytes with a cryptographically secure generator and
   store the base64url value in the deployment secret manager. Inject it only
   into the one-off task environment as `ADMIN_BOOTSTRAP_SECRET`; do not put
   the value in command arguments, a Compose file, source control, or logs.
3. With the production backend image and database reachable, run:

   ```sh
   docker compose -f infrastructure/docker/docker-compose.production.yml \
     --env-file <deployment-env-file> run --rm --no-deps \
     -e ADMIN_BOOTSTRAP_SECRET backend \
     pnpm exec tsx src/scripts/bootstrap-admin.ts <local-user-id>
   ```

   Compose `-e ADMIN_BOOTSTRAP_SECRET` passes the already-injected
   environment variable; do not put its value after `-e`.
4. On success, verify the promoted account and completion marker using a
   separately controlled database inspection, then immediately delete the
   bootstrap secret from the secret manager and terminate the one-off task.
   The database marker prevents reuse even if secret cleanup is delayed.

The command prints only the selected local user ID on success and a generic
failure on error. A wrong secret, ineligible user, or database error does not
promote an account; database operations roll back on failure. If the marker
is incomplete and no administrator exists, correct the deployment/account
issue and retry with a newly provisioned secret. If the marker is complete,
do not reset it; investigate through the controlled break-glass database
process. Break-glass recovery is not automated by A.8.

#### Worker approval audit

Migration 0015 adds `worker_approval_audit_events` with an event ID, worker
profile ID, previous and new approval state, acting local administrator ID,
decision timestamp, and optional reason limited to 500 characters. It stores
no token, credential, or unnecessary personal data. The administrator's
current local role and active state are checked inside the approval
transaction. The worker profile row is locked; the state change and event
insert commit or roll back together. Exactly one event is inserted for each
real state change. Repeated identical decisions are idempotent and do not
create events; terminal rejection remains unchanged.

The application has no audit update/delete operations or audit mutation
routes. This is an application-level append-only guarantee, not a
database-level immutability guarantee: a database owner or privileged
operator can still modify/drop the table or its rows. No trigger or restricted
database role was added. The audit table retains numeric actor/profile IDs
without foreign keys so that later account/profile deletion does not cascade
away history; IDs are not necessarily resolvable after such deletion.

### Milestone 7 — Admin MFA, provisioning, audit, and operations

**Likely files:**

- provider configuration and restricted admin login policy
- `backend/src/modules/auth/auth-audit.repository.ts`
- `backend/src/modules/auth/auth-audit.service.ts`
- admin provisioning/worker approval modules
- production deployment environment templates/docs

**Changes:** enforced MFA for admin identities; documented first-admin
provisioning; auditable role/suspension/link/session actions; provider and
session monitoring.

**Acceptance:** admin login fails without required MFA evidence; no public
admin creation; privileged changes emit durable audit events; operator runbook
and secret-manager configuration reviewed.

### Milestone 8 — isolated verification and rollout

**Tests:** provider sandbox end-to-end; isolated PostgreSQL and Redis;
multi-instance callback/state test; session expiry/revocation; worker Socket.IO
suspension/revocation; account linking; failure behavior on provider, Redis,
and PostgreSQL outages.

**Deployment:** apply migrations before backend startup (preserving
`src/start.ts` behavior); stage with a separate provider tenant; seed no
production admin via public API; monitor login and session errors; rollback
must preserve compatible session schema and not re-enable test-token routes.

**Acceptance:** reproducible test counts and failure injection; no shared
development services; existing allocation and booking suites pass; explicitly
document provider outage and token revocation guarantees.

## 9. Dependencies and deployment settings

A.4 uses `jose` for Auth0 ID-token signature/JWKS verification. A.5 reuses the
existing Redis client and Fastify rate-limit plugin; it adds no OIDC SDK,
OAuth framework, or cryptography dependency.

The A.5 production settings are:

- `AUTH0_ISSUER`: exact HTTPS issuer (trailing slash required).
- `AUTH0_CLIENT_IDS`: comma-separated allowlist containing exactly the web and
  native client IDs.
- `AUTH0_WEB_CLIENT_ID` and `AUTH0_NATIVE_CLIENT_ID`: distinct public Auth0
  application IDs.
- `AUTH0_WEB_REDIRECT_URIS`: comma-separated exact HTTPS web callback URLs.
- `AUTH0_NATIVE_REDIRECT_URIS`: comma-separated exact HTTPS app links or native
  custom-scheme callback URIs.
- `APP_SESSION_TTL_SECONDS`: local session lifetime in seconds (default 3600,
  allowed range 300–86400).
- `CORS_ORIGIN`: exact comma-separated web origin allowlist.
- `TRUST_PROXY`: nonzero, non-global setting matching the trusted TLS ingress.

All six Auth0 settings must be supplied through production environment
configuration and are forwarded by production Compose. `TRUST_PROXY` must
identify the actual TLS-terminating ingress; the routes reject production
requests that Fastify does not recognize as HTTPS. The IDs and callback URIs
must match the corresponding Auth0 registrations; no actual values have been
provisioned. There is no client secret, API audience, or offline-access scope
in this flow.

The safe placeholders in `backend/.env.example` and
`infrastructure/docker/.env.production.example` illustrate names and formats
only; they are not valid deployment settings. Do not copy placeholder Auth0
IDs, domains, callback URLs, database credentials, or proxy addresses into a
live environment.

Auth0 setup is two public applications: a web SPA/public client and a native
React Native application. Enable Authorization Code with PKCE S256 and register
each exact callback in the corresponding application. Do not add a client
secret to the native app. The backend exchanges the code and does not return
Auth0 access, ID, or refresh tokens.

The transaction lifetime is fixed at 600 seconds. Shared Redis TTL and an
atomic one-key Lua consume operation provide multi-replica expiry/single-use
behavior. Provider requests use fixed issuer-derived `/authorize`,
`/oauth/token`, and JWKS URLs; redirect following is disabled for token
exchange. Redis failover durability and production TLS/proxy configuration
remain operational verification items. A.9 implements distributed rate
limiting, but production topology and load behavior have not been verified.
Session validity is PostgreSQL-authoritative; no local JWT/session signing key or
refresh-token secret is used. Deployment still needs real Auth0 app
registrations, exact trusted origins and TLS proxy addresses, managed secret
delivery, monitoring, admin MFA policy, and audit events.

### A.9 — Distributed rate limiting

The backend uses the existing node-redis client. Each request increments a
Redis counter with a Lua script that combines `INCR`, first-hit `PEXPIRE`, and
`PTTL` atomically. This is a fixed window anchored to the first request rather
than a wall-clock-aligned window: it is simple and atomic, but permits a burst
across adjacent window boundaries. Counters expire automatically; there is no
local or process-only fallback. Keys have the bounded form
`pronto:rate-limit:v1:<policy>:<sha256(identity)>`; route identity uses
Fastify's registered route template, not the caller's raw URL or parameters.
No Redis `KEYS` scan is used.

| Policy category | Default | Key |
| --------------- | ------- | --- |
| General requests to registered `/v1` routes | 300 per 60 seconds | Trusted client IP + method + registered route template |
| Login initiation | 10 per 60 seconds | Trusted client IP, separate policy |
| Authorization callback/exchange and failed login attempts | 10 per 60 seconds | Trusted client IP, separate policy |
| Logout | 10 per 60 seconds | Trusted client IP |
| Authenticated session revoke and CSRF-token renewal | 10 per 60 seconds | Local authenticated user ID |
| Booking creation | 20 per 60 seconds | Local authenticated user ID |
| Allocation-offer and assigned-booking acceptance | 30 per 60 seconds | Local worker ID, separate per-route policies |
| User/service-category creation; worker creation, profile/service mutation and approval; manual offer creation | 10 per 60 seconds | Local authenticated user ID, separate per-operation policies |
| Socket.IO connection handshakes | 60 per 60 seconds | Direct TCP peer IP |
| `/health` and readiness routes | Not rate limited | Excluded |

Values are configurable with the corresponding `RATE_LIMIT_*_MAX` and
`RATE_LIMIT_*_WINDOW_MS` variables. Authentication limits use IP rather than
account identifiers so unknown account names cannot create unbounded keys or
expose account-specific throttling. Authenticated mutations additionally use
the current local user ID. All `/v1` registered routes also have a general
per-route IP counter; it is independent from the narrower operation counters.
The Socket.IO limiter uses the TCP peer address and deliberately ignores
forwarded-IP headers; clients behind a shared ingress therefore share that
peer's socket bucket unless a trusted client-IP integration is added.

Fastify's `request.ip` is used for HTTP limits and therefore follows its
`TRUST_PROXY` setting. Production configuration rejects unrestricted proxy
trust; operators must configure the actual trusted ingress/hop topology and
prevent direct untrusted access to the backend. No arbitrary forwarded header
is used independently of Fastify's proxy validation.

When the Redis client promptly reports failure, `/v1` requests and Socket.IO
handshakes fail closed with a generic 503 and no local-counter fallback. A
rejected HTTP request receives 429 and `Retry-After` computed from the
counter's remaining TTL, rounded up to seconds; no infrastructure or counter
headers are returned. A.10's network-partition test found that some in-flight
Redis requests remain pending rather than returning a bounded 503; see the
A.10 findings below. The next Redis operation after a successful reconnect
uses shared state when that state has not been lost. Health endpoints remain
available for liveness; readiness checks Redis dependency health. Defaults
are policy starting points, not traffic benchmarks. Automated disposable-Redis
tests cover two independent app/client instances, concurrent increments,
expiry, boundary behavior, identity separation, and prompt failure handling.
Production Redis failover, proxy-chain behavior, abuse tuning, and
load/performance characteristics remain **NOT VERIFIED**.

### A.10 — Multi-replica deployment and resilience evidence

The backend startup path now holds PostgreSQL advisory lock `(17103, 10)`
while it runs `drizzle-kit migrate`, so concurrently starting replicas
serialize migration execution. Two independent `src/start.ts` processes
successfully started against one fresh disposable PostgreSQL database and
Redis instance; both became ready after the complete 16-migration chain.
Direct concurrent `drizzle-kit migrate` invocations bypass this lock and one
of two concurrent invocations exited nonzero in an isolated negative-control
run. Use the normal locked startup path or run one migration command before
starting replicas; do not run the CLI concurrently.

Live two-process checks confirmed PostgreSQL session sharing and revocation,
Redis OIDC transaction consumption, distributed rate-limit counters,
allocation generation/lease races, and shared worker presence and offer state.
The same checks found that Socket.IO offer events are still emitted through
process-local rooms: a worker connected to replica B did not receive an offer
created on replica A, although the offer was accepted through B when explicitly
submitted. Cross-process Socket.IO delivery is therefore a release blocker.

Controlled Docker-network interruptions also left a rate-limited `/v1`
request and `/ready` pending beyond the probes' 6–11 second and 8 second
deadlines for Redis and PostgreSQL respectively. Readiness returned after the
network was restored, but the code has no explicit application-level deadline
for those in-flight operations. Do not treat reconnection as proof of bounded
failure behavior, Redis persistence/failover, or PostgreSQL recovery guarantees.

The production Compose file supplies one backend service and a published host
port, not an ingress or tested replica/load-balancer topology. Actual
Auth0, TLS ingress, trusted proxy addresses, Redis durability/eviction,
PostgreSQL backup/restore, graceful shutdown, and production load/resource
behavior remain **NOT VERIFIED**. See
[FINAL_RELEASE_READINESS.md](FINAL_RELEASE_READINESS.md) for the test topology,
exact outcomes, and remaining blockers. The A.10 recommendation is **NO-GO**
until cross-replica offer delivery and bounded dependency failure behavior are
addressed and the real deployment topology is validated.

## 10. Risks and mitigations

| Risk                                                 | Mitigation                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Phone verification is not implemented                | Add a verified-phone onboarding gate before account activation; do not treat an identity mapping as verification |
| Auto-linking by phone/email merges accounts          | Link only after proof of the existing account or audited assisted recovery                                       |
| Provider subject changes after pool/tenant migration | Persist exact issuer + subject and plan explicit identity migration                                              |
| Provider role claims or metadata elevate privilege   | PostgreSQL is the only role authority                                                                            |
| Session survives revocation or account/role change    | PostgreSQL check on every protected request and socket event; idle sockets recheck every 15 seconds             |
| PostgreSQL lookup increases request load/latency     | Start with one joined lookup; measure; add only bounded, invalidated cache if needed                             |
| Redis outage affects login transaction state         | Fail login closed; existing PostgreSQL sessions remain valid according to auth policy                            |
| Session expires without refresh                      | Require explicit reauthentication; no refresh-token system is implemented                                        |
| SameSite/cross-origin cookie mismatch                | Prefer same-site reverse proxy; otherwise explicit CORS/CSRF threat review                                       |
| Open Socket.IO connection after logout               | Session validation on privileged events and shared socket invalidation before relying on live connection         |
| India SMS delivery/cost/regulatory constraints       | Obtain provider quote, test delivery routes and applicable sender requirements before launch                     |
| Admin provider compromise                            | Mandatory MFA, restricted provisioning, audit, least privilege, emergency recovery procedure                     |
| Provider outage or account lockout                   | Define availability and support process; do not create an unauthenticated bypass                                 |
| Provider contract or region lock-in                  | Keep provider adapter narrow and local identity/session model provider-neutral                                   |

## 11. Decisions requiring approval

1. **Provider:** Auth0 is selected. Verify deployment-region fit, India SMS
   delivery, and cost during procurement; these are operational checks, not
   provider-selection blockers.
2. **Deployment platform/region:** AWS or another managed platform; required
   data residency and latency targets.
3. **Customer methods:** choose the Auth0 login factors and whether customers
   must provide email in addition to the required phone number. Phone ownership
   verification before activation/onboarding is approved policy.
4. **Worker identity policy:** choose provider login factors and any identity
   checks beyond the required, verified phone number.
5. **Administrator MFA:** required factors, separate provider application/pool
   policy, and whether phishing-resistant MFA is mandatory.
6. **Session policy:** the implemented default is a one-hour session, with
   configurable 5-minute to 24-hour bounds and no refresh flow. Approve any
   future refresh lifetime, per-device limit, and audit policy separately.
7. **Mobile scope:** React Native mobile and web clients are approved.
   Provider-specific mobile PKCE and web login/callback flows remain future
   implementation work.
8. **Existing accounts:** A.3 leaves existing users unmapped. Any future
   linking/recovery process must prove account control and must not infer
   ownership from contact equality.
9. **Worker approval:** whether approval creates a worker role/profile
   atomically and what rejection/reactivation semantics apply.
10. **Audit/retention:** authentication audit retention and privacy policy.
11. **OTP economics:** monthly sign-in volume, target SMS countries, resend
    abuse budget, and maximum acceptable delivery cost.
12. **Recovery/support:** provider account recovery behavior and
    support-assisted identity recovery policy.

Auth0 and client scope are approved. Resolve the remaining decisions before
implementing their corresponding login, onboarding, or session behavior.

## 12. Official provider sources

All links below are official vendor sources. Pricing and feature availability
can change; revalidate at procurement.

### Auth0

- [Authorization Code Flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce)
- [Authorization Code Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow)
- [Validate JSON Web Tokens](https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens)
- [JSON Web Key Sets and caching](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets)
- [Passwordless email OTP](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-otp)
- [Configure email or SMS passwordless](https://auth0.com/docs/authenticate/login/auth0-universal-login/passwordless-login/email-or-sms)
- [Auth0 MFA](https://auth0.com/docs/secure/multi-factor-authentication)
- [Email verification](https://auth0.com/docs/manage-users/user-accounts/verify-emails)
- [Auth0 pricing](https://auth0.com/pricing)

### Amazon Cognito

- [Authorization endpoint and state/nonce/PKCE parameters](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
- [Cognito ID token](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html)
- [Cognito access token](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html)
- [Cognito refresh-token rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
- [Email and phone verification](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-email-phone-verification.html)
- [Cognito MFA and passwordless constraints](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html)
- [Cognito endpoints and supported regions](https://docs.aws.amazon.com/general/latest/gr/cognito.html)
- [Cognito pricing](https://aws.amazon.com/cognito/pricing/)
- [Amazon SNS SMS pricing](https://aws.amazon.com/sns/sms-pricing/)

### Clerk

- [Clerk pricing](https://clerk.com/pricing)
- [Sign-up and sign-in options, email/phone, SMS allowlist](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options)
- [Clerk session-token claims](https://clerk.com/docs/guides/sessions/session-tokens)
- [Backend `verifyToken`](https://clerk.com/docs/reference/backend/verify-token)
- [Clerk user metadata](https://clerk.com/docs/guides/users/extending)
- [Social connections and framework guides](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/overview)
