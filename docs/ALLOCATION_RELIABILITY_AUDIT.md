# Pronto+ Allocation Reliability Audit

**Audit date:** 2026-11-01  
**Scope:** Source implementation, existing allocation and booking tests, Redis/PostgreSQL coordination, recovery, presence, and Socket.IO handling. No allocation code was modified.

## Executive Summary

PostgreSQL assignment is durable and the final assignment guard in `assignWorker()` prevents canceled, failed, or already-assigned bookings from being reassigned. Redis provides useful coordination, and atomic Redis Lua scripts reject expired offers and allow only one winner, but the PostgreSQL and Redis phases are not one transaction and stale Redis state can survive booking and process failures.

The biggest reliability risks are:

- Allocation lease expiration does not fence old processes; old work can continue after another instance owns the Redis lease.
- Worker rejection has a service method but no HTTP route, and cancellation/terminal transitions do not clean pending offers or winner state.
- Worker disconnection does not revoke pending offers, and Socket worker connections do not retry or reconcile presence updates.
- Offer expiry and tier recovery are implemented with multiple Redis/PostgreSQL workers, but the current code lacks crash, lease-loss, two-instance, cancellation, disconnection, and terminal-state integration coverage.

PostgreSQL remains the assignment source of truth. Redis winner and offer state is ephemeral and expires in normal paths, but it is not a substitute for durable booking state.

## Implementation Trace

### Candidate selection and tiers

- [allocation.service.ts](../backend/src/modules/allocation/allocation.service.ts): `allocate()` selects active worker-service candidates, calculates distance, reads active-job counts, scores candidates, sorts them, and divides them into tiers.
- [allocation.repository.ts](../backend/src/modules/allocation/allocation.repository.ts): `findCandidates()` filters active worker-service associations and available worker profiles. `getWorkerActiveJobCounts()` counts assigned, en-route, and working jobs.
- [ranking.util.ts](../backend/src/modules/allocation/ranking.util.ts) and [config/allocation.ts](../backend/src/config/allocation.ts): define tier sizes and ranking-related configuration.
- The active allocation score uses rating and completed jobs. Distance and active-job count are calculated/returned but do not affect `computeScore()`.

### Offer and acceptance coordination

- [tep.service.ts](../backend/src/modules/allocation/tep.service.ts): acquires a Redis allocation lease, transitions `PENDING` to `ALLOCATING`, creates the first tier, advances tiers, and resumes work.
- [allocation-offer.service.ts](../backend/src/modules/allocation/allocation-offer.service.ts): stores offers in Redis hashes and tracks offer keys in a Redis set.
- [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts): atomically checks offer identity, status, and Redis-server time, then claims a short-lived winner lock and marks the offer accepted.
- [allocation-lock.service.ts](../backend/src/modules/allocation/allocation-lock.service.ts): uses Redis keys for winner ownership and ownership-checked Lua release.
- [allocation-lease.service.ts](../backend/src/modules/allocation/allocation-lease.service.ts): leases booking allocation to an application-instance UUID with renew and ownership-checked release.

### Assignment and recovery

- [allocation-assignment.service.ts](../backend/src/modules/allocation/allocation-assignment.service.ts): Redis acceptance precedes a PostgreSQL conditional assignment.
- [bookings.repository.ts](../backend/src/modules/bookings/bookings.repository.ts): `assignWorker()` conditionally updates only a booking whose status is `ALLOCATING`.
- [allocation-expiration.worker.ts](../backend/src/modules/allocation/allocation-expiration.worker.ts): polls Redis every second and advances tiers for bookings with expired offers.
- [allocation-recovery.worker.ts](../backend/src/modules/allocation/allocation-recovery.worker.ts): scans PostgreSQL for `ALLOCATING` bookings every 30 seconds and invokes recovery.
- [allocation-recovery.service.ts](../backend/src/modules/allocation/allocation-recovery.service.ts): returns if a winner exists or active offers remain; otherwise resumes the current tier.

## Required Failure Scenarios

### A. No eligible workers exist

**Status: PASS (implementation), NOT VERIFIED (current isolated execution)**

**Relevant source**

- `AllocationService.createTiers()` in [allocation.service.ts](../backend/src/modules/allocation/allocation.service.ts).
- `AllocationRepository.findCandidates()` in [allocation.repository.ts](../backend/src/modules/allocation/allocation.repository.ts).
- `TepService.startAllocation()` in [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).
- `BookingsRepository.markAllocationFailed()` in [bookings.repository.ts](../backend/src/modules/bookings/bookings.repository.ts).

**Actual reason**

If candidate tiers are empty, `startAllocation()` performs a conditional PostgreSQL update from `ALLOCATING` to `ALLOCATION_FAILED`. The update is status-guarded, so repeated calls cannot modify a terminal booking.

If all candidates lack coordinates, the active allocator also filters them out and reaches the same terminal path.

**Existing test coverage**

- [allocation.integration.test.ts](../backend/src/modules/allocation/allocation.integration.test.ts) contains a no-worker integration test.
- The test was not runnable in the current environment because Redis/PostgreSQL services were unavailable. It therefore remains execution-not-verified.

**Minimum safe remediation**

- Keep the conditional terminal transition.
- Add an isolated integration test that proves the terminal status and absence of offers for both an empty candidate list and missing coordinates.

### B. All workers reject or their offers expire

**Status: FAIL**

**Relevant source**

- `AllocationOfferService.rejectOffer()` and `expirePendingOffers()` in [allocation-offer.service.ts](../backend/src/modules/allocation/allocation-offer.service.ts).
- `AllocationExpirationWorker.processExpiredOffers()` and `TepService.advanceTier()` in [allocation-expiration.worker.ts](../backend/src/modules/allocation/allocation-expiration.worker.ts) and [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).
- [allocation.routes.ts](../backend/src/modules/allocation/allocation.routes.ts): no worker-rejection HTTP route exists.

**Actual reason**

Expiry is implemented and advances to the next tier only after no active offer remains for the current booking tier. Rejection is implemented as a Redis method, but there is no route that worker clients can call, so worker rejection does not participate in the allocation lifecycle.

The expiry progression path also lacks focused integration coverage across all tiers, no-more-candidates exhaustion, and repeated expiry processing.

**Existing test coverage**

- [allocation-concurrency.test.ts](../backend/src/modules/allocation/allocation-concurrency.test.ts) proves an expired offer is marked expired and returned to expiry processing.
- It does not execute tier advancement, tier exhaustion, worker HTTP rejection, or multi-timer expiry concurrently.

**Minimum safe remediation**

- Add an authenticated worker rejection route that checks an active pending offer owned by the JWT worker.
- Make rejection atomically mark the offer rejected and release only the worker's coordination state.
- Keep tier advancement/status termination conditional on PostgreSQL `ALLOCATING` and the current allocation tier.
- Add tests for rejection, complete expiry, next-tier creation, and terminal exhaustion.

### C. An offer expires while a worker attempts acceptance

**Status: PASS (acceptance boundary), NOT VERIFIED (end-to-end timing)**

**Relevant source**

- `AllocationAcceptanceService.accept()` in [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts).
- Redis Lua obtains Redis-server time with `TIME`; it marks offers expired without creating a winner when `expiresAt <= nowMs`.
- [allocation-concurrency.test.ts](../backend/src/modules/allocation/allocation-concurrency.test.ts).

**Actual reason**

The offer expiry boundary is decided atomically in Redis rather than by application-process clock. One request either succeeds before the Redis-server timestamp check or finds the offer expired.

This does not make Redis and PostgreSQL assignment atomic: acceptance can win before expiry, then PostgreSQL assignment can later fail, be canceled, or encounter another state transition.

**Existing test coverage**

- The concurrency test covers an offer already expired and mismatched offer identity.
- It does not cover simultaneous acceptance exactly at the Redis expiry boundary.

**Minimum safe remediation**

- Preserve Redis-server time for the offer-acceptance decision.
- Before assignment, re-read the PostgreSQL booking and require `ALLOCATING`.
- Use a PostgreSQL conditional assignment so that a canceled or already terminal booking cannot be assigned after the expiry decision.
- Add deterministic boundary and process-delay tests.

### D. Two workers accept the same booking concurrently

**Status: PASS at coordination and assignment guards; HTTP race is NOT VERIFIED**

**Relevant source**

- `AllocationAcceptanceService.accept()` uses `SET ... NX EX 60` for the winner.
- `BookingsRepository.assignWorker()` updates only `status = ALLOCATING`.
- [allocation-concurrency.test.ts](../backend/src/modules/allocation/allocation-concurrency.test.ts).

**Actual reason**

Redis winner acquisition is mutually exclusive. Even if a second worker claims a separate offer, it cannot overwrite the winner. PostgreSQL also permits assignment only while the booking remains `ALLOCATING`, and the assignment update is conditional.

The Redis winner and PostgreSQL assignment are separate operations, so this is concurrency safety from two independent guards rather than distributed atomicity.

**Existing test coverage**

- The concurrency test verifies exactly one winner and one simultaneous acceptance at the Redis service layer.
- No HTTP-level two-worker acceptance race against a real isolated PostgreSQL database is currently executable.

**Minimum safe remediation**

- Keep the conditional PostgreSQL assignment.
- Add an HTTP-level concurrent acceptance integration test with two distinct worker JWTs and a real PostgreSQL transaction.
- Verify exactly one row becomes `ASSIGNED` and exactly one HTTP response succeeds.

### E. Redis winner acquisition succeeds but PostgreSQL assignment fails

**Status: PASS in code rollback; NOT VERIFIED against real PostgreSQL failure**

**Relevant source**

- `AllocationAssignmentService.acceptOffer()` in [allocation-assignment.service.ts](../backend/src/modules/allocation/allocation-assignment.service.ts).
- `AllocationAcceptanceService.rollbackAcceptance()` in [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts).

**Actual reason**

Assignment success is checked first, then any exception or missing booking triggers winner rollback. The rollback Lua script verifies winner ownership and restores an unexpired offer from `accepted` to `pending`; it removes the winner in the same Redis Lua operation.

Redis errors during rollback can still leave accepted/stale Redis state, and the implementation does not reconcile indefinitely without the recovery worker.

The mock rollback test proves the intended behavior only, not a real database outage or transaction timeout.

**Existing test coverage**

- [allocation-concurrency.test.ts](../backend/src/modules/allocation/allocation-concurrency.test.ts) mocks `assignWorker()` rejection and verifies winner removal plus offer restoration.
- There is no real PostgreSQL outage/constraint/connection-loss test.

**Minimum safe remediation**

- Preserve ownership-checked rollback.
- Add explicit reconciliation for Redis rollback failure and booking cancellation/assignment conflicts.
- Add real isolated PostgreSQL failure-injection tests, including timeout and process interruption.
- Do not infer successful PostgreSQL assignment from Redis state.

### F. PostgreSQL assignment succeeds but the process crashes before Redis cleanup

**Status: PASS for reassignment safety; NOT VERIFIED for crash cleanup**

**Relevant source**

- `AllocationAssignmentService.acceptOffer()` in [allocation-assignment.service.ts](../backend/src/modules/allocation/allocation-assignment.service.ts).
- `BookingsRepository.assignWorker()` in [bookings.repository.ts](../backend/src/modules/bookings/bookings.repository.ts).
- Redis offer/winner TTLs in [allocation-offer.service.ts](../backend/src/modules/allocation/allocation-offer.service.ts) and [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts).

**Actual reason**

PostgreSQL assignment commits first or does not commit at all. Crash after the commit leaves the winner lock and accepted offer temporarily stale, but they expire after their Redis TTL and all later assignments require PostgreSQL status `ALLOCATING`.

A stale winner TTL does not revert the durable assignment. Recovery checks PostgreSQL status before interpreting Redis and ignores terminal/assigned bookings.

**Existing test coverage**

- No crash-after-commit test exists.

**Minimum safe remediation**

- Keep PostgreSQL status as the final assignment truth.
- Add a durable reconciliation process or terminal-state Redis cleanup hook that removes booking offer/winner keys.
- Add crash injection immediately after the assignment transaction and verify PostgreSQL remains assigned and Redis stale state cannot overwrite it.

### G. Allocation process crashes after creating offers but before tier progression

**Status: FAIL for crash recovery completeness**

**Relevant source**

- `TepService.startAllocation()` in [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).
- `AllocationRecoveryService.recoverBooking()` and `TepService.resumeAllocation()` in [allocation-recovery.service.ts](../backend/src/modules/allocation/allocation-recovery.service.ts) and [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).
- `AllocationExpirationWorker` and recovery timers start on Fastify readiness in [allocation-expiration.worker.ts](../backend/src/modules/allocation/allocation-expiration.worker.ts), [allocation-recovery.worker.ts](../backend/src/modules/allocation/allocation-recovery.worker.ts), and [app.ts](../backend/src/app.ts).

**Actual reason**

Recovery is durable enough to inspect PostgreSQL allocation state. If active offers remain, it waits; if they expire, the expiration worker advances the tier; if no offers are created, recovery resumes the current tier.

However, tier reconstruction is not fully fenced and is not a single idempotent allocation-generation operation. `resumeAllocation()` calls `startTier()`, which recreates current-tier offers without checking that tier creation succeeded in an ownership/lease context and without checking the PostgreSQL status immediately inside that function. It also does not validate the PostgreSQL tier movement result before sending offers.

`startAllocation()` releases the lease in `finally` even though creation work may no longer own a valid lease if it expired.

**Existing test coverage**

- No process-crash recovery test exists.
- No offers-before-tier-transition crash test exists.
- Offer expiry unit coverage exists, but not recovery plus restart timing.

**Minimum safe remediation**

- Put offer generation behind a lease-fenced, PostgreSQL-conditional function.
- Persist the exact offer-generation generation/current-tier version before Redis writes.
- Re-read booking status and allocation tier immediately before each tier write.
- Treat `moveToNextAllocationTier()` returning no row as terminal and stop.
- Add crash points between first offer creation, tier persistence, and completion; restart instances and verify one offer set only.

### H. Allocation lease expires while the original process is still running

**Status: FAIL**

**Relevant source**

- [allocation-lease.service.ts](../backend/src/modules/allocation/allocation-lease.service.ts): 60-second TTL and owner-keyed renew.
- `TepService.startLeaseHeartbeat()` in [tep.service.ts](../backend/src/modules/allocation/tep.service.ts): renews every 20 seconds.
- `advanceTier()`, `resumeAllocation()`, and `startAllocation()` in [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).

**Actual reason**

The lease is renewed while allocation is active, but the implementation does not re-check lease ownership before candidate selection, tier persistence, offer creation, or tier release.

If renewal fails because the lease expired or another instance acquired it, the heartbeat stops locally, but the old process still executes its `try` block and sends offers. `finally` may call ownership-safe release, which is correct for deletion but does not prevent work already in progress.

This creates split-brain allocation after lease expiration. This is a fencing race, not an ownership verification gap in renewal/release alone.

**Existing test coverage**

- No lease-expiration heartbeat test.
- No lease-loss test.
- No old-process versus new-process race test.
- Lease renewal/release Lua ownership exists but is not covered by a scenario test.

**Minimum safe remediation**

- Add a generation/fencing token persisted with each allocation operation and compare it in every tier/offer mutation.
- Re-check lease ownership before tier state changes and each offer batch write.
- If ownership is lost, stop all heartbeat work immediately and return without creating offers.
- Use monotonic or Redis-time fencing and add stale-leader rejection tests.
- Consider a PostgreSQL allocation generation column only if required for long-lived crash recovery; do not rely on Redis TTL alone.

### I. A second application instance attempts recovery while the first instance is active

**Status: FAIL for complete fencing, PASS for basic lease mutual exclusion**

**Relevant source**

- [allocation-recovery.worker.ts](../backend/src/modules/allocation/allocation-recovery.worker.ts): every instance scans all `ALLOCATING` bookings.
- `AllocationRecoveryService.recoverBooking()` in [allocation-recovery.service.ts](../backend/src/modules/allocation/allocation-recovery.service.ts).
- `TepService.resumeAllocation()` and `advanceTier()` in [tep.service.ts](../backend/src/modules/allocation/tep.service.ts).
- [allocation-lease.service.ts](../backend/src/modules/allocation/allocation-lease.service.ts).

**Actual reason**

Only one instance should normally acquire a booking lease. The second instance sees the lease as absent/present after Redis operations and returns on basic `SET NX` or `renew` ownership.

The active instance can still lose or exceed the lease TTL while continuing work; after it expires, another instance may acquire the same booking lease. There is no fenced epoch, generation, or per-operation Redis ownership check. Both instances can therefore have in-flight work from overlapping lease owners.

PostgreSQL status and allocation-tier conditional updates provide some protection against tier overwrites, but offer creation and Socket.IO delivery remain multi-instance side effects that can duplicate.

**Existing test coverage**

- No two-instance recovery test.
- No lease-loss between instances test.
- No duplicate offer-generation integration test.

**Minimum safe remediation**

- Enforce a fencing generation in Redis and PostgreSQL booking state.
- All offer creation, tier movement, acceptance assignment, and lease release should verify the same generation/owner.
- Acquire a lease for recovery/resume and stop if renewal/ownership verification fails.
- Add a two-process/failure-injection test using the same booking and isolated Redis/PostgreSQL.

### J. A worker disconnects while an offer is pending

**Status: FAIL**

**Relevant source**

- [worker-socket.ts](../backend/src/realtime/worker-socket.ts): disconnect removes one socket from Redis and sets the worker offline only when the last connection remains.
- [worker-presence.ts](../backend/src/realtime/worker-presence.ts): connection set operations.
- `AllocationOfferService.createOffer()` and `AllocationAcceptanceService.accept()` in [allocation-offer.service.ts](../backend/src/modules/allocation/allocation-offer.service.ts) and [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts).

**Actual reason**

Disconnect correctly removes the worker's socket and can set the PostgreSQL profile offline when the last connection leaves. It does not revoke offers, mark the worker unavailable for acceptance, or move the offer to another worker.

Acceptance validates the JWT identity, offer hash, Redis winner, status, and expiry, but does not re-check the worker profile status or an active Redis socket/presence set.

The worker can reconnect and accept an outstanding offer, while disconnected workers still receive no notification to retry.

**Existing test coverage**

- Presence service and worker socket behavior have no focused pending-offer-disconnect integration test.
- No stale/disconnected-worker acceptance test exists.

**Minimum safe remediation**

- Define whether disconnect revokes an offer or only removes notification delivery; implement it explicitly.
- On accept, re-check PostgreSQL or a verified Redis presence status atomically enough to prevent a disconnected worker from winning if acceptance policy requires presence.
- Reject or expire offers for workers that leave before the TTL and advance tier/recovery accordingly.
- Add multi-connection disconnect tests to ensure the last connection is the only offline transition.

### K. A cancelled booking receives a delayed acceptance

**Status: PASS for reassignment prevention; NOT VERIFIED end-to-end race**

**Relevant source**

- `BookingsRepository.assignWorker()` in [bookings.repository.ts](../backend/src/modules/bookings/bookings.repository.ts): Redis winner can be claimed but PostgreSQL assignment requires status `ALLOCATING`.
- `AllocationAssignmentService.acceptOffer()` in [allocation-assignment.service.ts](../backend/src/modules/allocation/allocation-assignment.service.ts): assignment failure rolls the Redis winner/offer state back.
- [bookings.service.ts](../backend/src/modules/bookings/bookings.service.ts): cancellation validates owner/worker/admin and transitions state.
- [booking-status.ts](../backend/src/modules/bookings/booking-status.ts): cancellation leaves terminal states without re-transition paths.

**Actual reason**

The durable assignment update cannot assign a canceled booking. If cancellation wins before assignment, the conditional update finds no `ALLOCATING` row and assignment fails/rolls back Redis coordination.

If assignment wins first, cancellation must see the new status (`ASSIGNED` or later) and must use permitted transition rules. It cannot be represented as cancellation of an `ALLOCATING` row.

Delayed acceptance is not tested as a real concurrency race.

**Existing test coverage**

- Existing booking ownership and cancellation service tests cover authorization and state transitions.
- No delayed HTTP acceptance-versus-cancellation transaction race test exists.
- The allocation concurrency suite has assignment failure rollback, but not cancellation.

**Minimum safe remediation**

- Preserve and test `ALLOCATING` conditional assignment.
- Cancel pending offers and winner keys when cancellation commits; cleanup should be ownership-checked.
- Add acceptance-versus-cancellation race tests where both operations run concurrently.
- Verify the loser receives a conflict/unavailable response and the database remains terminal.

### L. A stale Redis offer or winner lock remains after booking reaches a terminal state

**Status: FAIL**

**Relevant source**

- `AllocationAcceptanceService.accept()` in [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts).
- `AllocationAcceptanceService.rollbackAcceptance()` in [allocation-acceptance.service.ts](../backend/src/modules/allocation/allocation-acceptance.service.ts).
- `BookingsRepository.assignWorker()`, `markAllocationFailed()`, `cancelBooking()`, and `completeBooking()` in [bookings.repository.ts](../backend/src/modules/bookings/bookings.repository.ts).

**Actual reason**

Winner and offer keys have Redis TTLs, but there is no explicit cleanup when cancellation, allocation failure, completion, or assignment commits. Terminal state does not appear in the Redis acceptance Lua script.

The Lua acceptance script can therefore mark a stale pending offer accepted, followed by a PostgreSQL assignment rejection. Rollback restores the stale offer to `pending` because it does not check PostgreSQL terminal status. The winner has separate TTL protection but can survive briefly after assignment or failure.

PostgreSQL remains safe: stale Redis alone cannot reassign a terminal/canceled/completed booking. This is an unbounded coordination cleanup and operator-visible stale-state issue until Redis TTLs expire.

**Existing test coverage**

- Winner release and ownership-checked release are covered in Redis unit tests.
- No terminal-state stale key cleanup test exists.
- No canceled/completed/allocation-failed stale offer test exists.

**Minimum safe remediation**

- Add a single reconciliation cleanup function for terminal booking offer/winner/lease keys.
- Invoke cleanup on cancellation, allocation failure, assignment success, and booking completion.
- Include PostgreSQL booking status check in Redis acceptance/reconciliation paths, and do not restore stale accepted offers to `pending` for terminal bookings.
- Use a Redis Lua cleanup script that only removes keys owned by the expected worker/generation.
- Add tests for canceled/completed/failed bookings and late worker acceptance.

## Cross-Scenario Race Summary

1. **Lease expiration and old process continuation:** The current lease heartbeat renews only the Redis key. Loss does not stop the old process's offer-generation loop. This is the primary lease-fencing defect.
2. **PostgreSQL/Redis split-brain:** Assignment is correctly guarded in PostgreSQL, but Redis cleanup, rollback, winner, and offer state are not transactional with the database assignment.
3. **Terminal booking cleanup:** Cancellation, completion, and allocation failure do not proactively remove Redis coordination keys.
4. **Recovering stale offers:** Expiration and recovery workers use process timers and Redis/PostgreSQL polling. They provide durable observations, but offer generation is not fenced by a persistent generation.
5. **Worker presence:** Disconnect is reflected in worker profile/socket sets, but pending offers are not revoked and acceptance does not enforce presence.

## Existing Test Assessment

| Area | Coverage |
| --- | --- |
| Winner lock exclusivity | Redis unit coverage exists; one worker wins. |
| Concurrent worker acceptance | Redis Lua service coverage exists; exactly one winner is observed. |
| Expired/mismatched offer | Redis unit coverage exists. |
| Assignment database failure rollback | Mocked repository rejection coverage exists. |
| Offer expiry key status | Redis unit coverage exists, including marking expired. |
| Winner release ownership | Redis unit coverage exists. |
| No eligible worker integration | Integration test exists; not executed in the current environment. |
| Allocation HTTP acceptance | Integration test exists; Redis/PostgreSQL execution unavailable. |
| Worker rejection route | No route and no test. |
| Crash recovery | No test. |
| Lease loss/renewal race | No test. |
| Multi-instance recovery | No test. |
| Worker disconnect pending offer | No test. |
| Cancel-versus-late acceptance | No test. |
| Terminal-state Redis cleanup | No test. |

The prior isolated Redis/PostgreSQL report recorded six passing allocation-concurrency tests and an isolated integration run, but the 2026-11-01 current environment could not execute those services. This audit does not claim an unexecuted test passed.

## Severity Priorities

### Critical

1. **PostgreSQL/Redis coordination is not compensated as one workflow.** Assignment success/failure, rollback, and Redis cleanup need durable reconciliation. Redis interruption, process crash, and terminal status race can leave stale coordination.

### High

3. **Terminal and canceled bookings do not proactively clean Redis offers/winners.** Stale pending offers can survive for expiry TTL and accept first before PostgreSQL rejects.
4. **No worker rejection route.** The service method is not reachable, reducing tier progression reliability.
5. **Pending offers survive worker disconnection.** A disconnected worker can leave offers open and acceptance can occur without presence verification.

### Medium

6. **Offer notification and terminal cleanup are not fully fenced/reconciled.** Redis offer writes now verify lease token and generation, but notification occurs after the Redis script and terminal cleanup remains absent.
7. **Candidate ranking is split from allocation effectiveness.** Distance and active jobs are calculated but excluded from the active score, so candidate selection quality can diverge from operational load.

## Three Most Important Fixes

1. **Implement durable reconciliation between PostgreSQL assignment and Redis coordination.**
   - PostgreSQL remains authoritative for assigned state.
   - Add startup/recovery reconciliation for stale accepted offers, winner keys, and booking terminal state.
   - Define rollback outcomes for Redis rollback failure and database outage.

2. **Clean Redis state and revoke offers on terminal/disconnect transitions.**
   - On cancellation, assignment, allocation failure, and completion, remove terminal-booking offer/winner/lease keys.
   - Add worker rejection and last-disconnect offer behavior.
   - Make acceptance re-check PostgreSQL status before/writing assignment and add cancellation, completion, crash, and disconnect integration tests.

## Phase 2.2 Fencing Implementation

Implemented on 2026-11-04:

- Added durable `bookings.allocation_generation`, defaulting to zero, with migration
  `0010_allocation-generation.sql`.
- Initial `PENDING -> ALLOCATING` transition increments the generation atomically.
- Recovery and tier advancement acquire a Redis lease bound to the current generation,
  then conditionally increment PostgreSQL to issue a newer generation before mutating
  tier state.
- Redis lease renew/release and generation rebinding verify the exact
  `instanceId:generation` token.
- Tier remaining counters and offer creation use Redis Lua checks that verify the
  lease token in the same Redis operation as the write. Offers persist their
  generation.
- Tier movement, assignment, and allocation failure transitions conditionally verify
  the expected generation and booking state.
- Acceptance supplies the current PostgreSQL generation; Redis rejects offers from a
  different generation and PostgreSQL assignment remains conditionally generation-
  guarded.
- Lease-loss renewal emits a structured `allocation_lease_lost` event and offer/tier
  mutation rejects stale ownership. Verified release cannot delete a newer owner's
  lease.

Scenario status changes supported by source and focused tests:

- **G:** PASS implementation / NOT VERIFIED under crash-and-restart infrastructure.
  Recovery issues a newer durable generation and stale offer writes are rejected.
- **H:** PASS implementation / NOT VERIFIED under a live lease-loss race. Old
  generation tier, counter, and offer mutations are rejected by PostgreSQL/Redis
  boundaries.
- **I:** PASS implementation / NOT VERIFIED with two live application instances.
  Redis lease exclusion plus durable generation rebinding prevents a recovered
  instance from using the prior generation.

Remaining correctness limits:

- PostgreSQL and Redis are still not one atomic transaction.
- A worker notification is emitted after the fenced Redis write; a lease can be lost
  between those operations, so notification delivery remains best-effort.
- Direct terminal-state cleanup remains outside booking transition handlers;
  reconciliation now provides retryable generation-scoped cleanup. Worker-
  disconnect revocation remains unimplemented.
- Real PostgreSQL/Redis crash, lease-loss, and multi-instance tests were not run
  because shared services were unavailable.

Validation executed:

- `pnpm build` — PASS (backend, web, docs).
- `pnpm check-types` — PASS (workspace tasks available in this checkout).
- `pnpm exec tsc --noEmit` from `backend` — PASS.
- `SKIP_TEST_DB_SETUP=1 pnpm exec vitest run src/modules/allocation/allocation-fencing.test.ts src/modules/allocation/ranking.util.test.ts src/modules/allocation/distance.util.test.ts src/modules/bookings/booking-status.test.ts --reporter=dot` — PASS, 4 files / 67 tests.
- `SKIP_TEST_DB_SETUP=1 pnpm exec vitest list` — PASS discovery; no tests were executed by this command.
- PostgreSQL/Redis integration, crash, and concurrency verification — NOT VERIFIED; no services were started.

Migration application command:

```powershell
cd C:\Users\salma\chore\backend
pnpm exec drizzle-kit migrate
```

## Phase 2.3 PostgreSQL-Authoritative Reconciliation

Implemented on 2026-11-04:

- Added `bookings.allocation_reconciliation_pending` and migration
  `0011_allocation-reconciliation.sql`.
- Assignment, cancellation, completion, and allocation failure mark the booking
  for reconciliation in the same PostgreSQL mutation.
- Added `AllocationReconciliationService`, reused by the existing recovery
  worker; no new queue or dependency was introduced.
- Terminal reconciliation reads PostgreSQL status and generation first, then
  removes only matching-generation offer state, winner state, and matching lease
  state through an idempotent Redis Lua operation.
- For an `ALLOCATING` booking, an accepted offer is restored to `pending` only
  when the matching-generation lease is absent. A valid active lease is left
  untouched.
- Assignment cleanup failures no longer undo a committed PostgreSQL assignment.
  The durable reconciliation marker causes retry on the next recovery cycle.
- Assignment rollback now re-reads PostgreSQL and restores Redis state only if
  the booking is still `ALLOCATING` at the same generation.
- Redis failures remain retryable and are logged; PostgreSQL assignment remains
  authoritative.

Failure scenarios addressed:

- **A:** committed PostgreSQL assignment with incomplete Redis cleanup is
  eventually reconciled through the durable marker.
- **B:** failed PostgreSQL assignment is rolled back only after current
  PostgreSQL state/generation verification.
- **C:** accepted Redis offers on still-allocating bookings are recoverable
  after the lease disappears; active lease state is preserved.
- **D:** terminal PostgreSQL states trigger generation-scoped offer, winner, and
  lease cleanup.
- **E:** Redis unavailability does not undo a committed assignment; retry remains
  durable.
- **F:** recovery first reads PostgreSQL and generation-fenced Redis state, so a
  newer generation is not removed or overwritten.

Remaining risks:

- PostgreSQL and Redis are still not atomic; reconciliation is compensating,
  not transactional.
- Redis outage during reconciliation is only eventually repaired when the
  recovery worker can retry.
- The worker notification race remains: notification delivery occurs after the
  fenced offer write.
- Worker-disconnect offer revocation remains intentionally out of scope.

Phase 2.3 validation:

- `pnpm build` — PASS.
- `pnpm check-types` — PASS.
- `pnpm exec vitest run src/modules/allocation/allocation-fencing.test.ts src/modules/allocation/allocation-reconciliation.test.ts src/modules/allocation/ranking.util.test.ts src/modules/allocation/distance.util.test.ts src/modules/bookings/booking-status.test.ts --reporter=dot` with `SKIP_TEST_DB_SETUP=1` — PASS, 5 files / 71 tests.
- `pnpm exec vitest list` with `SKIP_TEST_DB_SETUP=1` — PASS, 102 test cases discovered.
- PostgreSQL/Redis integration and crash/restart tests — NOT VERIFIED; no shared infrastructure was started.

## Phase 2.4 Terminal Cleanup and Disconnect Revocation

Implemented on 2026-11-04:

- Terminal reconciliation now discovers both indexed and orphaned offer hashes,
  removes matching-generation offers, winner state, leases, and generation-
  scoped tier counters, and remains safe to retry.
- Tier counters now include the allocation generation in their Redis key, so an
  old cleanup cannot remove a newer generation's counter.
- Assignment, cancellation, completion, and allocation failure continue to use
  the Phase 2.3 durable reconciliation marker; no second cleanup mechanism was
  added.
- Worker offer notifications now include `bookingId`, `offerId`, and
  `generation`.
- Worker connection removal uses one Redis Lua operation for `SREM` plus
  `SCARD`. Socket registration is awaited before disconnect cleanup, preventing
  a stale disconnect from racing a not-yet-recorded connection.
- Only the final active worker connection marks the worker offline and invokes
  pending-offer revocation. Revocation atomically checks worker identity and
  `pending` status, then marks only that worker's offer rejected and removes it
  from the indexed set.
- Revocation does not delete another worker's offer or any non-pending/newer-
  generation offer. Existing expiry/recovery processing remains responsible for
  eventual tier progression.
- Delayed Socket.IO notifications are treated as advisory. Acceptance still
  validates the current Redis offer/generation and the PostgreSQL
  `ALLOCATING`/generation assignment guard. Redis and Socket.IO are not atomic.

Phase 2.4 validation:

- `pnpm build` — PASS (backend, web, docs).
- `pnpm check-types` — PASS.
- `pnpm exec tsc --noEmit` from `backend` — PASS.
- `SKIP_TEST_DB_SETUP=1 pnpm exec vitest run src/modules/allocation/allocation-fencing.test.ts src/modules/allocation/allocation-reconciliation.test.ts src/modules/allocation/ranking.util.test.ts src/modules/allocation/distance.util.test.ts src/modules/bookings/booking-status.test.ts src/realtime/worker-presence.test.ts src/realtime/allocation-events.test.ts --reporter=dot` — PASS, 7 files / 76 tests.
- `SKIP_TEST_DB_SETUP=1 pnpm exec vitest list` — PASS, 107 test cases discovered.
- PostgreSQL/Redis integration, live Socket.IO disconnect races, and crash
  recovery — NOT VERIFIED; no shared infrastructure was started.

Remaining risks:

- Socket.IO notification delivery can still race offer revocation; stale
  notifications cannot authorize acceptance, but a valid notification may be
  received after the offer is revoked.
- Worker revocation scans booking offer indexes and depends on Redis
  availability; recovery retries allocation state, while Redis outages remain
  infrastructure-dependent.
- Direct terminal cleanup is compensating and generation-scoped, not atomic with
  PostgreSQL.

## Phase 2.5 Isolated Integration and Failure-Injection Verification

Verified on 2026-11-04 using disposable Docker containers created only for this
run:

- PostgreSQL 16.15, container `pronto-phase25-pg-20261104`, database
  `phase25`, ephemeral host port `32768`, no persistent volume.
- Redis 7, container `pronto-phase25-redis-20261104`, ephemeral test namespace
  on host port `56379`.
- Test credentials were generated only for the disposable containers and were
  not committed.
- No development database, development Redis, existing Docker volume,
  `FLUSHDB`, `FLUSHALL`, or destructive Docker command was used.

Migration verification:

- `pnpm exec drizzle-kit migrate --config drizzle.config.ts` from
  `C:\Users\salma\chore\backend` — PASS.
- All 12 migration records were applied to the isolated database.
- PostgreSQL reported version 16.15 and both
  `allocation_generation` and `allocation_reconciliation_pending` exist on
  `bookings`.

Executed verification:

- `pnpm exec vitest run src/modules/allocation/allocation.integration.test.ts src/modules/allocation/allocation-concurrency.test.ts src/modules/allocation/allocation-fencing.test.ts src/modules/allocation/allocation-reconciliation.test.ts src/realtime/worker-presence.test.ts src/realtime/allocation-events.test.ts --reporter=verbose`
  with isolated `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and
  `SKIP_TEST_DB_SETUP=1` — PASS, 6 files / 26 tests.
- `pnpm exec vitest run --reporter=dot` with the same isolated configuration —
  PASS, 14 files / 108 tests.
- After the regression fix,
  `pnpm exec vitest run src/modules/allocation/allocation-concurrency.test.ts src/modules/allocation/allocation.integration.test.ts --reporter=dot`
  — PASS, 2 files / 13 tests.
- `pnpm exec tsc --noEmit` from `backend` — PASS.
- `pnpm build` from the workspace root — PASS.

Confirmed defect and correction:

- `AllocationOfferService.expirePendingOffers()` previously called the
  private `expireOffer()` boundary without a generation. An old expiry
  invocation could therefore mark a same-worker replacement offer from a newer
  allocation generation as expired. `expireOffer()` now verifies the offer
  generation inside the same Redis Lua mutation, and the regression test
  verifies that generation 1 cannot expire a generation 2 offer.

Scenario results:

- **PASS:** isolated PostgreSQL migration chain and schema.
- **PASS:** PostgreSQL assignment and no-worker allocation failure through the
  real application/database/Redis path.
- **PASS:** Redis winner mutual exclusion and concurrent acceptance behavior.
- **PASS:** generation-aware lease, reconciliation, terminal cleanup, presence,
  and notification tests against isolated Redis.
- **PASS:** repeated full backend suite, 108/108.
- **NOT VERIFIED:** two independently running application processes with
  process termination and lease expiry; the current repository has no
  multi-process integration harness.
- **NOT VERIFIED:** live Socket.IO multi-connection and stale-disconnect races;
  unit-level presence coverage passed, but no client/server integration harness
  was available.
- **NOT VERIFIED:** PostgreSQL/Redis crash windows requiring process or
  container termination during the cross-system operation.

Redis scanning assessment:

- Unbounded `KEYS` calls exist in `resetBookingKeys()` in
  [config/redis.ts](../backend/src/config/redis.ts),
  `reconcileBooking()` and `revokeWorkerOffers()` in
  [allocation-offer.service.ts](../backend/src/modules/allocation/allocation-offer.service.ts),
  and `expirePendingOffers()` in the same service.
- The reconciliation and expiry scans run from background recovery/expiration
  workers. Worker-disconnect revocation runs from the disconnect handler and can
  therefore scan all booking offer indexes on a presence event.
- The scans are not count-bounded and are not cursor-based. Existing booking
  and offer key names support indexed cleanup for a known booking, but worker
  revocation and global expiry still require cross-booking discovery.
- No scaling defect was inferred from the isolated run, so no scan redesign was
  made in Phase 2.5. At production scale, replace global `KEYS` usage with
  cursor-based `SCAN` or a durable worker-offer index before relying on
  disconnect latency or recovery latency SLOs.

Final Phase 2.5 assessment: **CONDITIONAL PASS**. Durable migration,
assignment, Redis fencing, reconciliation, terminal cleanup, and the confirmed
expiry-generation race are verified against isolated services. Production
readiness remains conditional on genuine multi-process crash/restart,
cross-system fault-injection, and live Socket.IO race testing.

## Final Distributed Verification

Verified on 2026-11-04 with a new disposable PostgreSQL 16.15 container
(`final` database, ephemeral host port 32769) and Redis 7 container (host port
56479). The containers used no existing volumes or application data and were
removed after verification.

### Independent application processes

A temporary two-process harness launched two separate Node/tsx processes,
each importing the real lease, booking repository, offer, acceptance, and
assignment services. Each process generated its own `INSTANCE_ID`.

The harness used explicit command barriers:

1. Process A acquired generation 1.
2. Process B failed to acquire the held lease.
3. The harness deleted only this test booking's lease to model expiry.
4. Process B acquired the lease and atomically advanced PostgreSQL to
   generation 2.
5. Process B created a generation-2 offer.
6. Process A attempted offer creation, renewal, release, and assignment with
   generation 1.

Observed result: **PASS**. Process A's offer creation raised
`AllocationFenceError`; renewal and release returned false; stale assignment
returned null. Redis retained Process B's lease and generation-2 offer, and
PostgreSQL remained `ALLOCATING`, generation 2, with no worker assignment.

### Live Socket.IO verification

A temporary runner launched a real backend process and three real
`socket.io-client` connections using authenticated worker tokens.

Observed result: **PASS**.

- Two connections produced two Redis presence members.
- Disconnecting one left the offer pending and one connection online.
- A replacement connection was established before disconnecting the second;
  the offer remained pending and the worker remained online.
- Disconnecting the final connection marked the worker offline and revoked
  only the worker's pending offer.
- The delivered notification contained booking ID, offer ID, worker ID, and
  generation.
- Acceptance submitted after revocation returned HTTP 409.

### Redis key-scan remediation

Global keyspace scans were removed from allocation cleanup paths:

- Worker disconnect now reads `worker:<workerId>:offers:pending`, so its work
  is bounded by that worker's pending offers rather than all bookings.
- Expiry now reads `allocation:offers:pending`, avoiding a database-wide
  `KEYS booking:*:offer:*` scan.
- Offer creation, acceptance, rollback, rejection, expiry, revocation, and
  terminal reconciliation update the pending and worker indexes atomically
  where the operation is already Lua-based; stale index members are removed
  defensively.
- Booking-specific orphan discovery and generation-counter cleanup use
  incremental cursor batches through Redis `SCAN`, not `KEYS`. These are
  background reconciliation paths and are not atomic snapshots.
- `resetBookingKeys()` also uses incremental `SCAN`.

No schema migration or dependency was required. The index consistency tests
and isolated Redis tests passed.

### Final verification commands

- `pnpm exec drizzle-kit migrate --config drizzle.config.ts` against the
  disposable PostgreSQL instance — PASS, complete 12-migration chain.
- Temporary two-process fencing harness — PASS.
- Temporary live Socket.IO harness — PASS.
- `pnpm exec vitest run --reporter=dot` with isolated PostgreSQL/Redis —
  PASS, 14 files / 108 tests.
- `pnpm exec vitest run src/modules/allocation/allocation-concurrency.test.ts
  src/modules/allocation/allocation-fencing.test.ts
  src/modules/allocation/allocation-reconciliation.test.ts
  src/realtime/worker-presence.test.ts --reporter=dot` — PASS, 4 files /
  21 tests.
- `pnpm exec tsc --noEmit` from `backend` — PASS.
- `pnpm build` from the workspace root — PASS.
- `git diff --check` — PASS.

### Remaining limitations

- The process harness verified lease loss and stale mutations, but did not
  forcibly terminate a process at every PostgreSQL/Redis cross-system
  instruction boundary. Those crash windows remain **NOT VERIFIED** as
  deterministic end-to-end cases.
- Recovery-worker completion after a real process crash remains
  **NOT VERIFIED** with a shortened production recovery interval; the
  repository worker uses a 30-second timer.
- No production deployment, network partition, Redis failover, or PostgreSQL
  failover was exercised.

Final allocation reliability assessment: **CONDITIONAL PASS**. The previously
unverified independent-process fencing and live Socket.IO behavior now have
isolated evidence, and global allocation `KEYS` scans were removed. Crash
recovery and infrastructure-failure behavior still require deployment-like
fault-injection validation before production-readiness claims.

## Release-readiness alignment

This audit is the current source for allocation behavior. Earlier sections
describe pre-Phase-2 implementation states and are retained as historical
evidence. The current implementation uses generation-scoped leases and offers,
durable reconciliation markers, terminal cleanup, worker pending-offer
indexes, and incremental `SCAN` cleanup. The final release boundary is
documented in [FINAL_RELEASE_READINESS.md](FINAL_RELEASE_READINESS.md):
allocation is **CONDITIONAL PASS**, while the complete marketplace remains
**NO-GO** until production authentication, deployment-safe secrets/networking,
distributed rate limiting, and crash/failover verification are addressed.
