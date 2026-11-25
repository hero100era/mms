# Migration review: 20261106T040210Z_r2-row-count-fix

Scope: `docs/implementation_plan.md` R2.4 (corrective follow-up to
`20261106T035206Z_r2-workflow-temporal`).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
      N/A: no destructive statements.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: function bodies only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

The R2.4 exactly-one-row checks used `GET DIAGNOSTICS v_changed = rowcount`.
The PL/pgSQL diagnostics item is spelled `ROW_COUNT`; the wrong identifier made
every function fail to compile (`42601: unrecognized GET DIAGNOSTICS item`), which
`db:tests/survey_request.sql` caught on all five transitions. This migration
recreates the nine affected functions with `get diagnostics v_changed = row_count`.

**Process note.** `npm run db:check` (C1/C3/C5 + schema lint + org docs) does
**not** compile PL/pgSQL bodies, so it passed while the functions were broken.
Only `npm run db:test` exercised the calls. Both were run; the failure was found
and fixed before this review was signed.

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, changing
`SECURITY DEFINER` function bodies needs the `security-review` label and two
human reviewers before production apply.

## Destructive changes

None.

<!-- allow-destructive: none — R2.4 — no destructive statements in this migration -->
