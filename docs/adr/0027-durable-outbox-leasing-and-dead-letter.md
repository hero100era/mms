# ADR-0027: Durable Outbox Leasing, Exponential Retries, and Dead-Letter Handling

- Status: proposed
- Date: 2026-11-08

## Context

Phase R7.2 of the Rectification Plan (`docs/plans/rectification-implementation-plan.md`) requires hardening `core.outbox` against worker crashes, delivery failures, and job loss.

Prior limitations:
1. `private.job_poll` used `FOR UPDATE SKIP LOCKED`, but if a worker crashed after `job_begin`, the job was left in `processing` indefinitely with no expiration or automated recovery.
2. `private.job_complete` only supported terminal states (`done` and `failed`). A transient failure (such as an email SMTP timeout or rate limit) permanently failed the job on its first attempt, losing the message.
3. No tracking of error classification (`transient` vs `fatal`), leasing expiration, or dead-letter state.

## Decision

1. **Schema Enhancements on `core.outbox`:**
   - Expand `status` check constraint to include `'dead_letter'`: `status in ('pending', 'processing', 'done', 'failed', 'dead_letter')`.
   - Add `max_attempts int not null default 5` with `max_attempts >= 1` check constraint.
   - Add `lease_expires_at timestamptz` and `leased_by text` to track ownership and lease timeout.
   - Add `last_error_class text` to record error classification (`transient`, `fatal`, `max_attempts_exceeded`, `unhandled`).
   - Add partial index `outbox_lease_expired_ix` on `lease_expires_at` where `status = 'processing'`.

2. **Durable Claim and Polling Semantics:**
   - Update `private.job_poll`: select jobs where `(status = 'pending' AND next_at <= now()) OR (status = 'processing' AND lease_expires_at < now())` with `FOR UPDATE SKIP LOCKED`.
   - Update `private.job_begin`: set `status = 'processing'`, `attempts = attempts + 1`, `lease_expires_at = now() + p_lease_seconds::interval`, and record `leased_by`.
   - Provide `private.job_heartbeat`: allows long-running jobs to extend their lease durably.

3. **Intelligent Retry and Dead-Letter Transitions:**
   - Update `private.job_complete(p_job_id, p_status, p_error, p_error_class, p_retry_delay_seconds)`:
     - `p_status = 'done'`: clear lease, set `done`.
     - `p_status = 'retry'`: if `attempts < max_attempts` and `p_error_class <> 'fatal'`, set `status = 'pending'`, calculate exponential backoff delay `min(300, 5 * 2^(attempts-1))` (or explicit override), and clear lease. If `attempts >= max_attempts`, automatically escalate to `dead_letter`.
     - `p_status = 'dead_letter'`: transition immediately to `dead_letter` and record error details.
     - `p_status = 'failed'`: backward-compatible terminal failure state.

## Consequences

- If a worker process abruptly dies or disconnects, other workers automatically reclaim orphaned jobs once their lease expires.
- Transient network or remote service errors automatically retry with jittered exponential backoff.
- Poison-pill jobs or exhausted retries are isolated in `dead_letter` for operator inspection and alerting without stalling the queue.
