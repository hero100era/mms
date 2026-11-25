# Migration review: 20261124T041640Z_wave3-hardening

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Wave 3 Hardening & Boundary Normalization:
- Update `private.org_unit_name()` to handle active external station queries cleanly.
- Enhance `private.position_proposal_record()` with proposer assignment and event telemetry.
- Normalize `iam.job_title` grant for `int_sysadmin` from column-level to table-level select.
- Implement `auth.break_glass_drill_record()` to track drill operations and timestamps.
- Update `auth.session_touch()` idle interval for external and break-glass accounts.
- Implement `api.staff_qualification_revoke()` with validation, event emission, and change context tracking.

## Destructive changes

<!-- allow-destructive: REVOKE SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title FROM int_sysadmin — WAVE3-HARDENING — Normalize column-level select permissions to table-level select for int_sysadmin -->

## Rollback / forward-fix strategy

Forward-fix: The updated functions and grants are forward-compatible replacements and additive helpers.
Rollback: Revert to previous definer function definitions and column-level grants if necessary.
