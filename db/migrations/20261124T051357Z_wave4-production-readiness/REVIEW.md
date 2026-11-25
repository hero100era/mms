# Migration review: 20261124T051357Z_wave4-production-readiness

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Wave 4 Production Readiness Hardening:
- In `private.document_version_record_scan`: enforce approved scanner engine check.
- In `private`: revoke execute on `audit_no_truncate()` from PUBLIC.
- In `audit_trail`: restrict change_log table select permissions by revoking from `int_manager`.
- In `auth.resolve_entra`: remove automatic reactivation of deactivated accounts on directory sync conflict.
- In `api.break_glass_state`: normalize operational drill overdue threshold to 92 days.

## Destructive changes

<!-- allow-destructive: REVOKE SELECT ON TABLE change_log FROM int_manager — WAVE4-READINESS — Restrict change_log audit access to compliance and sysadmin roles -->

## Rollback / forward-fix strategy

Forward-fix: The updated functions and role grants are forward-compatible security hardenings.
Rollback: Re-grant select on audit_trail.change_log to int_manager and restore previous function definitions if required.
