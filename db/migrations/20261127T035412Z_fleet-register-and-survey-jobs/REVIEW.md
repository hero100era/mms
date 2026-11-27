# Migration review: 20261127T035412Z_fleet-register-and-survey-jobs

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

allow-destructive: REVOKE EXECUTE ON FUNCTION next_certificate_no() FROM PUBLIC; — FLEET-SURVEY-JOBS — Revoke default PUBLIC EXECUTE on new private helper function (no role grants are removed; regex matches subsequent GRANT SELECT ... TO int_*).

## Rollback / forward-fix strategy

Forward-fix: All added tables, sequence, helper function, RLS policies, and triggers are additive and forward-compatible.
Rollback: Drop the added `survey.*` and `fleet.*` tables, `fleet.certificate_no_seq`, and `private.next_certificate_no()` in reverse dependency order if rollback is required before data depends on them.
