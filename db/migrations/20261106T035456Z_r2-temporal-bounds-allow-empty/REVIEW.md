# Migration review: 20261106T035456Z_r2-temporal-bounds-allow-empty

Scope: `docs/implementation_plan.md` R2.5 (corrective follow-up to
`20261106T035206Z_r2-workflow-temporal`).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      Each constraint is dropped and re-added `NOT VALID`, then validated.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

The `[)` bounds checks added by `20261106T035206Z_r2-workflow-temporal` rejected
the `empty` range that `private.deprovision_staff_user` writes when it closes a
future-dated staff position that never started (`set valid = 'empty'::tstzrange`).
`db:tests/auth.sql` caught this immediately. The four constraints are replaced
with `isempty(valid) OR (lower_inc(valid) AND NOT upper_inc(valid))`, which still
forbids `[]`/`()` bounds and still rejects a malformed non-empty range, but keeps
the degenerate empty value legal.

`db/tests/rectification_r2_5.sql` now also asserts that an empty range is
accepted, so the regression cannot return unnoticed.

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, a migration
touching authority-adjacent invariants needs the `security-review` label and two
human reviewers before production apply. Automated gates are green but do not
substitute for that sign-off.

## Destructive changes

Only `DROP CONSTRAINT` immediately followed by re-adding the same constraint
name with a widened predicate, plus `VALIDATE CONSTRAINT`. No data, columns,
tables or policies are removed.

<!-- allow-destructive: DROP CONSTRAINT org_unit_coverage_valid_bounds_ck, org_membership_valid_bounds_ck, role_assignment_valid_bounds_ck, staff_position_valid_bounds_ck — R2.5 — each is re-added in the same migration with the same name and a predicate that additionally permits the 'empty' range written by private.deprovision_staff_user -->
