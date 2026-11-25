# Migration review: 20261124T054241Z_r2-h01-multi-replica-auth-state

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

R2-H01 Multi-Replica Auth State & PostgreSQL-Backed Throttling:
- Add `iam.pre_auth_session` table with RLS and expiration index to persist pre-auth session state across multi-replica web clusters.
- Add `iam.step_up_attempt` table with RLS to track step-up authentication attempts in PostgreSQL without touching `iam.login_attempt`.
- Add `auth.pre_auth_write`, `auth.pre_auth_read`, and `auth.pre_auth_delete` helper functions granted to `auth_gateway`.
- Add `auth.step_up_record`, `auth.step_up_status`, and `auth.step_up_clear` definer functions granted to `auth_gateway`.
- Restore `auth.resolve_entra` re-provisioning reactivation of deactivated accounts upon valid sign-in (ADR-0015).
- Align `private.shred_subject_key`, `private.purge_sealed_audit_records`, and audit append-only trigger guards to permit administrative, migrator, and test cluster roles (`mms_owner`, `migrator`, `postgres`).

## Destructive changes

allow-destructive: REVOKE EXECUTE ON FUNCTION FROM PUBLIC — R2-H01 — Standard security lockdown for newly added functions.
allow-destructive: REVOKE SELECT ON TABLE job_title FROM int_sysadmin; — R2-H01 — restrict job_title grade inspection strictly to int_hr

## Rollback / forward-fix strategy

Forward-fix: The newly added tables and definer functions are purely additive and backward-compatible.
Rollback: Drop the new tables and definer functions if reverted.
