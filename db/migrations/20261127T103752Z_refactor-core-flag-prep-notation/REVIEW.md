# Migration review: 20261127T103752Z_refactor-core-flag-prep-notation

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

- Split `core.flag` into public state reference `core.flag` (`code`, `name`, `fullname`, `is_hssc`, `is_active`) and internal RO agreement table `core.flag_ro_agreement` (`email`, `tel`, `fax`, `contact`, `contract_file`, `contract_start`, `contract_end`), removing the column-level `ext_user` grant workaround on `core.flag` while keeping `core.flag_ro_agreement` restricted to internal staff roles with RLS and audit capture.
- Restructure `core.survey_preparation` to reference `core.survey_preparation_section (id)` via `section_id` (`ON DELETE CASCADE`), removing the duplicate direct `survey_catalog_id` link and mirroring `core.checklist_section` -> `core.checklist_item`.
- Remove redundant array column `core.class_notation.incompatible_notations` (`core.notation_compatibility` enforces relational compatibility).
- Align `core.breakdown_template` (`created_by`, `updated_by`) and `fleet.ship_breakdown` (`applied_by`) from `varchar(100)` to `uuid` (`fleet.ship_breakdown.applied_by` references `iam.app_user (id)`).
- `pre.sql` drops `api.ship_breakdowns` so `applied_by` can alter cleanly, and `schema.sql` restores `api.ship_breakdowns` and its grants; `nontx.sql` creates `survey_prep_section_id_ix` concurrently.

## Destructive changes

allow-destructive: ALTER TABLE core.flag DROP COLUMN email / tel / fax / contact / contract_file / contract_start / contract_end; — REFACTOR-CORE — Extracted RO agreement and contact columns into internal-only `core.flag_ro_agreement`.
allow-destructive: REVOKE SELECT (code, fullname, is_active, is_hssc, name) ON TABLE flag FROM ext_user; — REFACTOR-CORE — Replaced column-level grant restriction with full-table `SELECT` on clean public `core.flag` while restricting `core.flag_ro_agreement` to internal roles.
allow-destructive: ALTER TABLE core.survey_preparation DROP COLUMN survey_catalog_id; — REFACTOR-CORE — Replaced redundant direct catalog FK with `section_id` referencing `core.survey_preparation_section (id)`.
allow-destructive: ALTER TABLE core.class_notation DROP COLUMN incompatible_notations; — REFACTOR-CORE — Removed unvalidated integer array duplicating `core.notation_compatibility`.
allow-destructive: ALTER TABLE core.breakdown_template / fleet.ship_breakdown ALTER COLUMN ... TYPE uuid; — REFACTOR-CORE — Converted legacy string user attribution columns to `uuid`.

## Rollback / forward-fix strategy

Forward-fix: Add corrective columns, indexes, or data backfill scripts in a subsequent forward migration if needed.
Rollback: Re-add the extracted columns on `core.flag`, `core.survey_preparation.survey_catalog_id`, `core.class_notation.incompatible_notations`, and `varchar(100)` attribution columns in a forward migration while dropping `core.flag_ro_agreement`.
