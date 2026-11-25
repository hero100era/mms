# Migration review: 20261108T085334Z_r8-5-closure

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Phase R8.5 Hardened Baseline Closure:
- Enforce synchronous denial in `private.pre_request()` for expired break-glass accounts.
- Add `auth.break_glass_sweep_expired()` for asynchronous cleanup of expired sessions and accounts.
- Normalize quarterly break-glass drill timing to explicit 92-day operational threshold in `auth.break_glass_drill_overdue()` and `auth.break_glass_state()`.
- Add `private.enqueue_security_alert()` for transactional enqueuing of security-critical alerts into `core.outbox`.

## Destructive changes

<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION FROM PUBLIC — R8.5 — Standard security lockdown for definer functions -->

## Rollback / forward-fix strategy

Forward-fix: The functions are forward-compatible replacements and additive helpers.
Rollback: Revert to previous definer function definitions if necessary.
