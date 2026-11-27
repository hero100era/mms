# Migration review: 20261127T103940Z_refactor-survey-status-and-catalog-links

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

- Rename `core.survey_status_enum` to `core.survey_execution_status_enum` and move execution-progress status onto `survey.survey_line.execution_status`.
- Replace `fleet.survey_audit.survey_status` with `schedule_status varchar(2) references core.survey_audit_status (code)` (expanded with `'PP'` = Postponed in `010_core_reference.sql`), separating vessel due-window compliance standing from survey execution status; expose `schedule_status` and `schedule_status_name` on `api.ship_survey_audits`.
- Replace `survey.survey_request_item.occ_survey_code` (`varchar(20)`) with `survey_catalog_id integer references core.survey_audit_catalog (id) on delete set null`, matching `fleet.survey_audit` and `survey.survey_line`, with partial unique index `survey_request_item_req_cat_uk`.
- Align `survey.job.job_type` check constraint to `('survey', 'audit', 'doc')`, matching `core.survey_audit_catalog.item_kind`.
- `pre.sql` drops `api.ship_survey_audits` and the legacy `survey_status` columns before dropping `core.survey_status_enum`; `nontx.sql` creates `survey_request_item_cat_ix` and `survey_request_item_req_cat_uk` concurrently.

## Destructive changes

allow-destructive: DROP TYPE IF EXISTS survey_status_enum RESTRICT; — REFACTOR-SURVEY-STATUS — Replaced ambiguous enum with `core.survey_execution_status_enum` for job execution lines and `core.survey_audit_status` FK for fleet schedule compliance.
allow-destructive: ALTER TABLE survey.job DROP CONSTRAINT job_type_ck; — REFACTOR-SURVEY-STATUS — Updated job kind check from `('survey', 'audit', 'ms')` to `('survey', 'audit', 'doc')` to align with `core.survey_audit_catalog.item_kind`.
allow-destructive: ALTER TABLE survey.survey_request_item DROP COLUMN occ_survey_code; — REFACTOR-SURVEY-STATUS — Standardized catalog linkage from string code to `survey_catalog_id integer`.

## Rollback / forward-fix strategy

Forward-fix: Add corrective status codes or backfill `schedule_status` / `execution_status` in a subsequent migration if needed.
Rollback: Re-create `core.survey_status_enum`, restore `survey_status` on `fleet.survey_audit` / `survey.survey_line`, restore `occ_survey_code` on `survey.survey_request_item`, and restore the prior `api.ship_survey_audits` view in a subsequent migration.
