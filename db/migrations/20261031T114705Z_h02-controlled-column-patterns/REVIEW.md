# Migration review: 20261031T114705Z_h02-controlled-column-patterns

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

allow-destructive: ALTER TABLE controlled_column DROP CONSTRAINT controlled_column_event_fk; — H-02 — Allow comma-separated event types and wildcard event patterns in audit_trail.controlled_column
