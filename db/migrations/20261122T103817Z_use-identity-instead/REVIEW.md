# Migration review: 20261122T103817Z_use-identity-instead

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

None. Legacy table-owned sequences are dropped because identity columns manage their own internal sequences attached directly to the table columns per SQL standard (`ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY`).

## Rollback strategy

Reverting to `serial` defaults can be done by creating replacement sequences and setting column defaults to `nextval(...)`, or rolling back to migration 87.
