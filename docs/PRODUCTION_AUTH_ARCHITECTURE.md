# Pronto+ Production Authentication Architecture

**Assessment date:** 2026-11-06  
**Status:** Architecture proposal only. No provider is selected and no
authentication implementation is included.

## 1. Executive recommendation

Use a managed OIDC provider, with Pronto+ acting as a backend-for-frontend
(BFF) for browser login and owning durable application sessions in PostgreSQL.
The provider authenticates the person; the local database remains authoritative
for Pronto+ identity mapping, roles, active state, worker approval, and
authorization.

**Provisional provider preference: Auth0**, subject to confirming:

1. The actual managed deployment platform and required data-residency region.
2. India SMS delivery availability, route quality, and total per-message cost.
3. Forecast monthly active users and the acceptable authentication budget.
4. Whether browser-only login is sufficient for the first release or native
   mobile clients are in scope.

Auth0 most closely matches the requested single-provider OIDC, email/phone
passwordless, and selectively enforced administrator MFA model. The current
repository and approved direction do not establish cloud-provider affinity.
Auth0 tenant-region suitability for the deployment must be verified before
provider approval; this assessment does not establish that Auth0 has an India
tenant region.

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

This recommendation is not a production-readiness certification. Provider
selection and the policy decisions in §11 require approval before
implementation.

## 2. Existing repository architecture

### JWT and authentication

- [`auth.ts`](../backend/src/plugins/auth.ts) decorates Fastify with
  `app.authenticate`. It calls `request.jwtVerify()` and returns a generic
  `401 Unauthorized` on verification errors.
- [`jwt.ts`](../backend/src/plugins/jwt.ts) configures `@fastify/jwt` with
  `JWT_SECRET` and `JWT_EXPIRES_IN`. The application code does not configure
  issuer, audience, key ID, or an algorithm allowlist for this JWT.
- [`auth.types.ts`](../backend/src/modules/auth/auth.types.ts) defines claims
  as `{ userId, role }`, where role is `customer`, `worker`, or `admin`.
- [`auth.routes.ts`](../backend/src/modules/auth/auth.routes.ts) exposes
  authenticated `GET /v1/auth/test`. It registers `POST
  /v1/auth/test-token` only when `NODE_ENV === "test"`; the route signs a
  caller-provided user ID and role and is a test utility, not a production
  identity mechanism.
- There is no production login, OIDC callback, refresh, logout, session, or
  identity-linking flow in the inspected auth module.

### Local users and worker state

- [`users.ts`](../backend/src/db/schema/users.ts) stores a required unique
  `phoneNumber`, name, nullable email, local role, `isActive`, and timestamps.
  Email is not unique. There are no provider issuer/subject fields, verification
  flags, session records, or password hashes.
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
- [`socket.ts`](../backend/src/realtime/socket.ts) verifies the presented JWT
  through `app.jwt.verify()` and copies its payload into `socket.data.user`.
  It does not look up the user, active state, session, or worker status.
- [`worker-socket.ts`](../backend/src/realtime/worker-socket.ts) gates worker
  behavior by the token role and uses the token's `userId`. It does not reject
  inactive users, suspended workers, missing/deleted worker profiles, or
  revoked sessions.
- [`env.ts`](../backend/src/config/env.ts) validates the current JWT secret
  length and production placeholders, but has no provider or local-session
  settings.
- [`app.ts`](../backend/src/app.ts) does not currently register a cookie
  parser, although `@fastify/cookie` is already listed in the backend
  dependencies. A cookie-backed BFF would need to register/configure it and
  align cookie parsing, CSRF, CORS, and JWT extraction.
- [`redis.ts`](../backend/src/config/redis.ts) provides a shared Redis client
  used for presence and allocation coordination. The approved direction keeps
  PostgreSQL authoritative for session/refresh validity; Redis may cache or
  coordinate but must not be the only revocation record.
- [`start.ts`](../backend/src/start.ts) runs Drizzle migrations before loading
  the server. New schema migrations should follow that existing startup
  behavior.
- Migrations are SQL files under `backend/src/db/migrations/`, with Drizzle
  journal/snapshot metadata. No authentication mapping or session migration is
  present.
- Tests use Vitest. `backend/vitest.config.ts` sets `NODE_ENV=test`, loads
  optional test environment configuration, and `vitest.setup.ts` can initialize
  the test schema unless `SKIP_TEST_DB_SETUP=1`. Existing integration tests
  exercise test-token issuance; there is no dedicated production auth or
  session-rotation test suite.

### Immediate consequences

1. A verified provider identity cannot map to a local user without schema and
   repository additions.
2. Because `phoneNumber` is currently required, an email-only customer cannot
   currently be represented. Email is also nullable and non-unique. The
   approved email-or-phone login requirement therefore needs a deliberate
   contact schema and account-linking migration.
3. `isActive` and worker suspension do not currently revoke already signed
   JWTs.
4. JWT role claims remain valid until token expiry even if the local role
   changes.
5. Authentication is currently signature verification only; it is not
   production identity issuance or durable session validation.

## 3. Provider comparison

The comparison uses each provider's public documentation and public pricing
page as retrieved on 2026-11-06. Prices are vendor-listed USD examples, before
tax, SMS delivery charges, negotiated discounts, and any deployment-specific
costs. Recheck before procurement.

| Requirement | Auth0 | Amazon Cognito | Clerk |
|---|---|---|---|
| Authorization code + PKCE | Documented authorization-code/PKCE flow; hosted Universal Login | `/oauth2/authorize` and code flow; supports state, nonce, and PKCE parameters | Primary docs emphasize Clerk SDK-managed sign-in/session tokens. Generic external OIDC callback fit should be confirmed before selection. |
| Email sign-in | Passwordless email OTP/link documented | Email verification and email OTP support depend on configured pool features | Email code and link documented |
| Phone sign-in | Passwordless SMS OTP documented | Phone OTP and phone verification documented; uses SNS | Phone OTP documented; production requires paid plan and country SMS allowlist |
| Email/phone verification | Provider verification workflows documented | Provider verification workflows documented | Verification flows documented |
| Administrator MFA | MFA factors documented; selective policy can be implemented with provider flow/actions, subject to chosen plan and configuration | TOTP/SMS/email MFA supported for local users, but required MFA cannot coexist with passwordless OTP first factors in a pool | MFA is a paid-plan feature; per-role enforcement and the desired BFF behavior need validation |
| Backend token verification | RS256/JWKS documented; validate issuer, audience, signature, and claims | RS256 user-pool JWTs and JWKS documented; verify ID/access tokens independently | `verifyToken`/`authenticateRequest`, issuer/audience/JWKS options documented |
| Stable identity key | `(iss, sub)`; connection changes/account linking require controlled mapping | Pool-scoped `sub`; pool migration means new issuer/subject mappings must be planned | Instance-scoped subject/user ID; instance migration requires mapping |
| India deployment region | Must confirm available tenant/data-residency region; no India region is asserted here | Official endpoint list includes Mumbai `ap-south-1` and Hyderabad `ap-south-2` | India hosting/data-residency region not established by reviewed docs |
| India SMS | Depends on configured delivery route and contract; quote required | SNS pricing, country delivery constraints, sender registration, and account readiness apply | International SMS is listed as market rate; India must be enabled in the SMS allowlist |
| Main operational cost driver | MAU tier, plan/MFA features, and SMS provider charges | MAU feature tier plus SNS SMS and SES email charges; AWS setup and operations | MRU tier plus paid SMS; MRU is not equivalent to MAU |
| Main lock-in | Tenant/connection-specific subject and Actions; migration needs subject mapping | AWS user-pool issuer, `sub`, pool settings, Lambda triggers, and AWS SMS/email integration | Clerk instance IDs, APIs, SDKs, and session model |
| Fit for this BFF design | Strong | Strong OIDC fit, with admin/customer MFA-flow constraint | Less clear unless exchange from Clerk session into local app session is explicitly approved |

### Public pricing comparison

#### Auth0

The current public B2C pricing page lists Essentials from **$35/month** and
Professional from **$240/month**. Published monthly tier examples include:

| MAU tier | Essentials | Professional |
|---:|---:|---:|
| 500 | $35/month | $240/month |
| 5,000 | $350/month | $1,000/month |
| 10,000 | $700/month | $1,600/month |
| 30,000 | $2,100/month | Contact sales |
| 50,000 | $3,500/month | Not available at listed tier |

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

**Auth0 — provisional best fit.** It supplies hosted OIDC-oriented flows,
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

## 4. Proposed end-to-end protocol

### Selected integration boundary: browser BFF

For the current Next.js web client, make the Fastify backend the OIDC
confidential client and BFF. The browser does not receive provider refresh
tokens or retain provider tokens in local storage. The backend owns OAuth
transaction state and local application sessions.

1. **Start:** browser navigates to `GET /v1/auth/oidc/start?method=...`.
   The backend creates cryptographically random `state`, `nonce`, and
   PKCE `code_verifier`; stores a one-use transaction record with a short
   expiry in shared Redis or PostgreSQL; then redirects to provider
   authorization with `code_challenge=S256`, `state`, `nonce`, `openid`,
   `profile`, and only the contact scopes required.
2. **Provider authentication:** provider-hosted UI performs the configured
   email or phone authentication. Administrator login is routed through an
   admin policy/client that requires MFA. The provider does not set Pronto+
   business roles.
3. **Callback:** provider redirects to
   `GET /v1/auth/oidc/callback` with a one-use authorization code and state.
   The backend consumes the transaction once, verifies state, and exchanges
   the code over TLS with the provider using the PKCE verifier and confidential
   client authentication where required.
4. **Validate identity:** use a maintained OIDC/JWT library or provider SDK.
   Validate signature from issuer JWKS, an explicit algorithm allowlist,
   exact issuer, exact client audience, expiry/not-before, and nonce. Reject
   missing or mismatched claims. Apply the provider's documented handling for
   `azp` when multiple audiences are present. Do not accept an ID token as an
   access token for unrelated APIs.
5. **Identity mapping:** find `(issuer, subject)` in PostgreSQL. Do not auto-link
   accounts merely because email or phone values match. Use provider verification
   attributes only as verified contact facts, not as the stable account key.
6. **Provisioning/linking:** existing accounts require explicit verified
   linking or a controlled migration. A first-time verified customer can be
   created under a customer-only policy. A worker request creates a local
   onboarding request; only an authorized administrator can approve it and
   grant the local worker role/profile. No public admin registration exists.
7. **Local authorization:** within a database transaction, resolve the local
   user, current role, `isActive`, worker approval/profile, and suspension
   state. Reject inactive or unauthorized accounts. Provider groups/metadata
   never directly grant a Pronto+ role.
8. **Create session:** insert a durable PostgreSQL `app_sessions` row and the
   first refresh-token record. Store no provider access token or provider
   refresh token. Persist provider issuer/subject mapping, not provider tokens.
9. **Issue app access token:** issue a short-lived Pronto+ access JWT (target
   5 minutes) containing local `sub`/user ID, `sid`, `iss`, `aud`, `iat`,
   `exp`, `jti`, and optionally authentication context such as MFA assurance.
   Role may be omitted and resolved from PostgreSQL; if included for convenience,
   it is non-authoritative.
10. **Refresh:** browser sends the opaque refresh cookie to
    `POST /v1/auth/refresh`. In one PostgreSQL transaction, lock the session,
    validate the presented token hash, consume it, issue a new random refresh
    token and store its hash, and mint a new short-lived access JWT. A consumed
    token replay revokes the session/family and is audited.
11. **Logout:** `POST /v1/auth/logout` revokes the PostgreSQL session, clears
    cookies, and initiates best-effort Socket.IO invalidation. A provider logout
    can be added to the redirect flow if provider SSO logout is required; local
    logout must not depend on provider availability.

The refresh cookie should be `Secure`, `HttpOnly`, narrowly scoped to the auth
path, and `SameSite=Lax` when same-site deployment permits it. Cookie-authenticated
mutations, refresh, and logout require CSRF protection, including Origin
validation and a CSRF token strategy. If frontend/API are cross-site, cookie
policy and CORS must be reviewed together and `SameSite=None; Secure` requires
strong CSRF controls.

If native mobile clients are in the first release, use a public-client
authorization-code + PKCE flow in the system browser and add a narrowly
specified one-time code/token exchange with the backend. Do not embed a client
secret in a mobile application. This mobile boundary requires approval.

## 5. Proposed PostgreSQL data model

No schema or migrations are created in this task.

### `external_identities`

| Column | Purpose |
|---|---|
| `id` UUID primary key | Internal identity mapping key |
| `user_id` integer not null FK to `users.id` | Local user |
| `issuer` text not null | Canonical exact OIDC issuer |
| `subject` text not null | Provider-stable subject |
| `created_at`, `updated_at` timestamptz not null | Mapping lifecycle |

Constraints/indexes:

- Unique `(issuer, subject)` prevents one external identity mapping to multiple
  local users.
- Index `user_id` supports listing linked identities and account lifecycle.
- Multiple external identities may link to one local user only through an
  authenticated, explicit, verified linking process.
- Do not use email/phone as the primary or unique provider mapping key.

### Contact attributes on `users`

The approved ability to authenticate using either email or phone does not fit
the current schema exactly: `phone_number` is required and unique, while email
is nullable and non-unique. A migration must define a canonical contact model:

- Permit a contact to be absent when the other method is used, if product
  policy allows email-only customers.
- Normalize phone numbers to E.164 before uniqueness checks.
- Normalize email consistently (without unsafe provider-specific alias
  rewriting).
- Add unique partial indexes for non-null normalized email and phone if each
  is intended to identify one local account.
- Store verification flags/timestamps only if the product needs a local copy
  of provider verification state; define how provider changes synchronize.

Keep local `role` and `is_active` in PostgreSQL. Provider metadata is not the
authorization database.

### `app_sessions`

| Column | Purpose |
|---|---|
| `id` UUID primary key | Also used as JWT `sid` |
| `user_id` integer FK to users | Owning local identity |
| `created_at`, `expires_at`, `last_used_at` timestamptz | Session lifetime |
| `revoked_at` timestamptz nullable | Durable revocation |
| `revoke_reason` text nullable | Controlled reason enum/string |
| `auth_time` timestamptz nullable | Provider authentication time |
| `mfa_verified_at` timestamptz nullable | Trusted provider MFA evidence |
| `user_agent_hash` nullable | Optional device label support; avoid raw sensitive data |

Indexes:

- `(user_id, created_at DESC)` for session listing and revoke-all.
- Partial index on active sessions as operational query needs are measured.
- `expires_at` index for bounded cleanup; expired rows may be archived/deleted
  under retention policy.

### `refresh_tokens`

One row per rotated opaque token, retained until the associated session/token
family expiry so reuse can be detected.

| Column | Purpose |
|---|---|
| `token_hash` bytea or fixed-length hex primary/unique key | Hash/HMAC of random token; never store the raw token |
| `session_id` UUID FK to app_sessions | Session/token family |
| `issued_at`, `expires_at` timestamptz | Token validity |
| `consumed_at` timestamptz nullable | Rotation state |
| `replaced_by_hash` nullable | Rotation audit linkage |

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

## 6. Proposed API contract

All success/error schemas below are proposals. Do not expose provider errors or
distinguish unknown accounts in user-facing login failures.

### OIDC start and callback

- `GET /v1/auth/oidc/start?flow=customer|worker|admin` — create state/nonce/
  PKCE transaction; redirect to provider. `admin` flow is not self-registration
  and must use the stronger MFA policy.
- `GET /v1/auth/oidc/callback?code=...&state=...` — consume transaction,
  exchange and validate, map/provision local user under policy, create local
  session, set cookies, redirect only to a pre-registered allowlisted
  destination.
- Never accept arbitrary `returnTo` redirects.
- For a mobile client, a separate `POST /v1/auth/exchange` can accept a
  provider access/ID token only after client PKCE and provider-client
  configuration are defined. Prefer code exchange with backend validation over
  accepting arbitrary identity tokens from a client.

### Current user and session lifecycle

- `GET /v1/auth/me` — requires valid app access JWT and active session; returns
  local user profile, role, account state, and worker approval summary, not
  provider tokens.
- `POST /v1/auth/refresh` — consumes refresh cookie, rotates token atomically,
  updates access cookie/JWT; `401` on invalid/revoked/expired/reused family.
- `POST /v1/auth/logout` — revokes the current session and clears cookies;
  idempotent response.
- `GET /v1/auth/sessions` — list only caller-owned active sessions with safe
  device metadata, creation and last-use times.
- `DELETE /v1/auth/sessions/:sessionId` — revoke only caller-owned session;
  admin-wide session revocation requires a separate audited admin action.

### Customer onboarding

- First verified email or phone login can create a local `customer` only if
  self-registration is enabled by policy.
- If an identity matches an existing local contact, do not auto-link solely on
  matching contact value. Require proof of the existing account or assisted
  linking.
- `POST /v1/auth/onboarding/customer` may collect profile data after verified
  identity if self-provisioning needs explicit consent; it cannot set role.
- Contact and account enumeration responses must be generic.

### Worker onboarding and administrator provisioning

- `POST /v1/workers/onboarding` creates a request associated with the
  authenticated user; it does not grant worker role or an active worker profile.
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
  non-deleted worker profile, approved onboarding, and status other than
  `suspended`.
- Preserve all existing route-level ownership checks and booking state
  transitions.
- A provider identity being verified does not approve a user to become a
  worker or administrator.

### Sessions and revocation guarantee

**Proposed guarantee:** for protected HTTP requests and state-changing worker
Socket.IO events, session revocation, user deactivation, role changes, and
worker suspension take effect on the next authorization check after the
PostgreSQL transaction commits. Requests/events already authorized before that
commit can finish; authentication cannot undo an operation already in flight.

Implement this by including `sid` in the short-lived app JWT and performing a
PostgreSQL lookup on each protected request/event that verifies:

- Session exists, not revoked, and not expired.
- User is active and local role is current.
- Worker profile exists and is not deleted/suspended for worker actions.

This yields prompt revocation but adds a DB read (preferably one joined query)
per protected HTTP request and protected socket event. Redis may cache active
session/account state only if invalidation is emitted after the PostgreSQL
commit and a bounded stale window is explicitly documented. Since Redis
pub/sub is not durable, a cache hit must not be treated as permanent authority.
Start with PostgreSQL checks; optimize only after measured load.
If PostgreSQL is unavailable for that authorization check, protected requests
and privileged socket events fail closed.

At Socket.IO connection time, re-check the session/user/worker state in
PostgreSQL. Re-check each privileged worker event. Logout should invalidate
active sockets where practical; cross-process socket invalidation requires a
shared Socket.IO adapter or another shared notification mechanism. The current
Socket.IO setup has no configured Redis adapter, so immediate cross-replica
disconnect of an already-open socket is not currently available. Until that is
implemented, do not treat a live socket as authorized solely because its
handshake once succeeded.

### Refresh, cookies, logs, and test isolation

- Refresh tokens are opaque, high-entropy, hashed at rest, rotated on every
  use, and single-use. Replay revokes the session family.
- Cookies are Secure/HttpOnly, with strict same-site deployment preferred and
  CSRF protection for cookie-authenticated requests.
- Use generic login, refresh, and account-linking errors. Do not reveal whether
  a phone/email exists.
- Never log authorization headers, cookies, provider codes/tokens, refresh
  tokens, client secrets, or full credential-bearing URLs.
- Preserve test-token issuance only when `NODE_ENV === "test"`. Test signing
  keys and provider fixtures must be isolated from production. Production
  configuration should fail if test-only provider configuration or routes are
  enabled.

## 8. Implementation roadmap

Each milestone is reviewable independently. Provider implementation starts
only after provider and policy approval.

### Milestone 1 — Provider decision and threat model

**Files:** this document; deployment/operations decision record.

**Decisions:** provider, region, browser vs mobile scope, email/phone UX,
administrator MFA requirement, provider outage policy, login and linking
policy, session revocation SLO, budget.

**Acceptance:** signed-off provider architecture; verified tenant region and
India SMS quote; staging/test separation and admin MFA policy documented.

### Milestone 2 — Schema and migration

**Likely files:**

- `backend/src/db/schema/users.ts`
- new `backend/src/db/schema/external-identities.ts`
- new `backend/src/db/schema/app-sessions.ts`
- new `backend/src/db/schema/refresh-tokens.ts`
- optional `backend/src/db/schema/auth-audit-events.ts`
- `backend/src/db/schema/index.ts`
- new numbered SQL migration plus generated snapshot and `_journal.json`
- relevant migration fixtures and isolated DB setup

**Changes:** identity mapping; durable sessions and rotated token history;
contact normalization/uniqueness compatible with email-or-phone users; worker
approval state separate from availability/suspension.

**Acceptance:** unique provider identities; referential integrity; safe rollout
for existing records; migration applied to isolated PostgreSQL; no provider
token persisted.

### Milestone 3 — OIDC transaction and verifier adapter

**Likely files:**

- new `backend/src/modules/auth/oidc/oidc-provider.ts`
- new `backend/src/modules/auth/oidc/oidc-transaction.service.ts`
- new `backend/src/modules/auth/oidc/oidc.routes.ts` or extend
  `auth.routes.ts`
- `backend/src/config/env.ts`
- dependency manifest only if provider SDK/JWT/JWKS implementation is not
  safely supported by current packages

**Changes:** authorization redirect, PKCE, one-time state/nonce, callback code
exchange, ID-token verification, JWKS caching.

**Acceptance:** issuer/audience/signature/nonce/expiry/state/PKCE negative tests;
unknown `kid` rotation tests; no secrets or tokens in logs; provider errors
mapped to generic external responses.

### Milestone 4 — Identity mapping and onboarding policy

**Likely files:**

- `backend/src/modules/auth/auth.service.ts`
- `backend/src/modules/auth/identity.repository.ts`
- `backend/src/modules/auth/identity.service.ts`
- `backend/src/modules/users/users.repository.ts`
- new worker onboarding route/service/repository/schema
- admin route/service for worker approval and bootstrap operation

**Changes:** lookup by `(issuer, subject)`, controlled customer provisioning,
explicit safe account linking, pending worker onboarding, admin-only approval,
no public admin registration.

**Acceptance:** no contact-only auto-link; local role cannot be set by client;
approved workers only receive worker privileges; existing booking ownership
tests remain passing.

### Milestone 5 — Local application sessions and refresh

**Likely files:**

- `backend/src/modules/auth/session.repository.ts`
- `backend/src/modules/auth/session.service.ts`
- `backend/src/modules/auth/refresh-token.service.ts`
- `backend/src/plugins/jwt.ts`
- `backend/src/plugins/auth.ts`
- `backend/src/modules/auth/auth.routes.ts`
- `backend/src/config/env.ts`

**Changes:** durable PostgreSQL session, short-lived app JWT with `sid`,
HttpOnly refresh cookie, transactional rotation, replay detection, logout,
session list/revoke.

**Acceptance:** refresh single-use; concurrent refresh serialized; replay
revokes session; logout revocation is immediate on next check; no raw refresh
token in DB/logs; CSRF/cookie tests pass.

### Milestone 6 — HTTP and Socket.IO state enforcement

**Likely files:**

- `backend/src/plugins/auth.ts`
- `backend/src/realtime/socket.ts`
- `backend/src/realtime/worker-socket.ts`
- `backend/src/realtime/socket.ts` and app setup if a shared adapter is
  selected
- relevant users/workers/booking authorization tests

**Changes:** resolve session/user/role from PostgreSQL; reject inactive
accounts; worker profile/approval/suspension checks at connect and on
privileged events; revoke live socket access after logout.

**Acceptance:** account suspension, role change, worker suspension, logout,
and refresh replay deny subsequent HTTP and socket operations; booking owner
and allocation authorization regression suites remain unchanged and passing.

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
multi-instance callback/state test; session refresh/replay races; worker
Socket.IO suspension/revocation; account linking; failure behavior on provider,
Redis, and PostgreSQL outages.

**Deployment:** apply migrations before backend startup (preserving
`src/start.ts` behavior); stage with a separate provider tenant; seed no
production admin via public API; monitor login and refresh errors; rollback
must preserve compatible session schema and not re-enable test-token routes.

**Acceptance:** reproducible test counts and failure injection; no shared
development services; existing allocation and booking suites pass; explicitly
document provider outage and token revocation guarantees.

## 9. Dependencies and deployment settings

No dependencies or exact provider variables are approved yet. After provider
selection, likely settings include:

- OIDC issuer/discovery URL.
- OIDC client ID and confidential client credential (secret manager only).
- Exact callback URL(s), allowed post-login redirect origins.
- Expected audience/client ID and permitted signing algorithms.
- JWKS cache TTL / unknown-key refresh limits if not safely defaulted by the
  selected library.
- Local application JWT signing/verification key material and rotation key ID.
- App access-token lifetime; session and refresh-family lifetime.
- Secure cookie domain/path/same-site settings.
- Provider administrator policy/client and required MFA evidence mapping.
- OIDC transaction-state TTL and storage configuration.
- Optional SMS/email budget alerts, provider delivery configuration, and
  permitted destinations.

The existing `@fastify/jwt` can remain for local app JWTs if it can meet the
issuer/audience/key-rotation requirements. OIDC ID-token verification should
use a maintained library that supports discovery/JWKS caching, nonce, issuer,
audience, and algorithm checks. Add a dependency only if current packages do
not meet those requirements; do not write custom JWT/JWKS validation.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing phone-required schema blocks email-only users | Resolve contact/account policy and migrate safely before customer self-onboarding |
| Auto-linking by phone/email merges accounts | Link only after proof of the existing account or audited assisted recovery |
| Provider subject changes after pool/tenant migration | Persist exact issuer + subject and plan explicit identity migration |
| Provider role claims or metadata elevate privilege | PostgreSQL is the only role authority |
| Long-lived local access JWT survives suspension | PostgreSQL session/account check on every protected request/event |
| PostgreSQL lookup increases request load/latency | Start with one joined lookup; measure; add only bounded, invalidated cache if needed |
| Redis outage affects login transaction state | Fail login closed; existing PostgreSQL sessions remain valid according to auth policy |
| Refresh replay causes session revocation | Single-flight client refresh and clear reauthentication UX; never accept replay silently |
| SameSite/cross-origin cookie mismatch | Prefer same-site reverse proxy; otherwise explicit CORS/CSRF threat review |
| Open Socket.IO connection after logout | Session validation on privileged events and shared socket invalidation before relying on live connection |
| India SMS delivery/cost/regulatory constraints | Obtain provider quote, test delivery routes and applicable sender requirements before launch |
| Admin provider compromise | Mandatory MFA, restricted provisioning, audit, least privilege, emergency recovery procedure |
| Provider outage or account lockout | Define availability and support process; do not create an unauthenticated bypass |
| Provider contract or region lock-in | Keep provider adapter narrow and local identity/session model provider-neutral |

## 11. Decisions requiring approval

1. **Provider:** approve Auth0 provisionally, select Cognito, select Clerk, or
   defer pending procurement. Auth0 is not final until region and cost review.
2. **Deployment platform/region:** AWS or another managed platform; required
   data residency and latency targets.
3. **Customer methods:** email OTP/link, phone SMS OTP, or both; whether one
   verified method is sufficient to create an account; whether a customer must
   provide both contacts.
4. **Worker identity policy:** whether workers may use either contact method
   and what identity checks are required beyond provider verification.
5. **Administrator MFA:** required factors, separate provider application/pool
   policy, and whether phishing-resistant MFA is mandatory.
6. **Session policy:** access-token duration, refresh lifetime, per-device
   session limit, and the proposed next-check revocation guarantee.
7. **Mobile scope:** whether native clients need a public-client PKCE flow in
   the first implementation.
8. **Existing accounts:** safe migration/linking process for current
   phone-number users, including phone normalization and email uniqueness.
9. **Worker approval:** whether approval creates a worker role/profile
   atomically and what rejection/reactivation semantics apply.
10. **Audit/retention:** authentication audit retention and privacy policy.
11. **OTP economics:** monthly sign-in volume, target SMS countries, resend
    abuse budget, and maximum acceptable delivery cost.
12. **Recovery/support:** provider account recovery behavior and
    support-assisted identity recovery policy.

Implementation must wait for these decisions and explicit provider selection.

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
