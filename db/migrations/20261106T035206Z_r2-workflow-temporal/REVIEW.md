# Migration review: 20261106T035206Z_r2-workflow-temporal

Scope: `docs/implementation_plan.md` R2.4 and R2.5.

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
      N/A: no destructive statements.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      pgschema generated `ADD CONSTRAINT ... NOT VALID` followed by
      `VALIDATE CONSTRAINT` for all four `[)` bounds checks.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration; all
      existing temporal rows were verified to already use `[)` bounds.
- [x] Regulated-data impact reviewed. No rows are rewritten.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

**R2.4 — atomic workflow transitions.** All five `api.survey_request_*`
transition RPCs now `UPDATE ... WHERE id = p_id AND status = <expected state>`
and verify `GET DIAGNOSTICS rowcount = 1`, raising a stable
`workflow_conflict` (SQLSTATE 40001) otherwise. The `FOR UPDATE` lock and the
in-transaction audit event were already present. Idempotency keys deliberately
remain out of scope: ADR-0024 is still proposed.

**R2.5 — temporal validity.** Explicit
`CHECK (lower_inc(valid) AND NOT upper_inc(valid))` constraints on
`iam.staff_position`, `iam.role_assignment`, `iam.org_membership` and
`core.org_unit_coverage`, making the `[)` convention enforceable rather than
implicit. Subject rows are now locked `FOR UPDATE` in `org_coverage_set/end`,
`staff_position_close`, `role_assignment_grant`, `membership_grant` and
`invite_external_user` before periods are closed/opened.

**Tests.** `db/tests/rectification_r2_5.sql` asserts the constraints and that a
`[]` range is rejected; `apps/web/app/actions/workflow-concurrency.test.ts`
uses two independent PostgreSQL connections to prove concurrent first revisions
produce one logical document with revisions 1 and 2 (R2.2 required barrier
test).

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, changing
`SECURITY DEFINER` function bodies needs the `security-review` label and two
human reviewers before production apply. Automated gates are green but do not
substitute for that sign-off.

## Destructive changes

None.

<!-- allow-destructive: none — R2.4/R2.5 — no destructive statements in this migration -->
