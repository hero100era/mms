# Migration review: 20261124T101901Z_pre-baseline-closure

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Pre-baseline closure hardening:
- In `auth.resolve_entra`: retain deactivated user status upon Entra ID sign-in reconciliation (F-H01 terminal deactivation).
- In `api`: revoke SELECT on `position_job_titles` from `int_sysadmin` (restricted strictly to `int_hr`).
- In `api.staff_qualification_grant`: call `private.set_change_context(trim(p_reason))` prior to insert.
- In `iam.step_up_attempt`: create concurrent index `step_up_attempt_at_ix` on `(at)`.

## Destructive changes

allow-destructive: REVOKE SELECT ON TABLE position_job_titles FROM int_sysadmin; — PRE-BASELINE-CLOSURE — Restrict position_job_titles select permission strictly to int_hr role

## Rollback / forward-fix strategy

Forward-fix: The changes are additive security hardenings, audit context bindings, and performance indexes.
Rollback: Re-grant SELECT on api.position_job_titles to int_sysadmin and restore previous function definitions if required.
