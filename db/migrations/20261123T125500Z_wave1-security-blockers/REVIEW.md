# Migration Review: `20261123T125500Z_wave1-security-blockers`

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary
Closes Wave 1 database security and runtime blockers identified in the pre-baseline code review:
- **C-03 & H-07:** Revokes `EXECUTE` on `private.upload_prepare` and `private.upload_mark_uploaded` from `web_anon` and read-only roles, adds `p_created_by` and `private.upload_get_for_finalize(uuid)` for ownership/entity verification.
- **C-04:** Excludes `core.outbox.payload` from `audit_trail.change_log` and fixes stale `'audit'` schema rows in `audit_trail.excluded_column`.
- **C-05:** Restricts `api.user_suspend` and `api.user_reactivate` to `kind = 'external'` for non-sysadmin callers and blocks self/service suspension.
- **C-06:** Removes the session-writable `mms.runtime` GUC bypass from `private.is_approved_scanner()`.
- **H-09:** Returns `email` from `auth.set_password()` so invite acceptance populates session `email`.
- **H-15:** Fixes `v_changed boolean` → `integer` in `api.emergency_suspend_user` and `api.emergency_revoke_assignment`.
- **H-16:** Adds `ra.valid @> now()` to `auth.user_roles()`.

## Destructive changes

<!-- allow-destructive: DROP FUNCTION IF EXISTS private.upload_prepare(uuid, text, uuid, text, text, text, timestamptz) — C-03/H-07 — replace unauthenticated 7-arg signature with 8-arg authenticated signature -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION private.upload_mark_uploaded(uuid, bytea, bigint, text) FROM web_anon, int_viewer, int_compliance, int_hr, int_finance — C-03 — revoke unauthenticated and read-only role upload execution -->

## Rollback strategy

Forward-fix or restore from migration 88 snapshot. Function signatures and privilege grants can be reverted by reapplying migration 88 function definitions.
