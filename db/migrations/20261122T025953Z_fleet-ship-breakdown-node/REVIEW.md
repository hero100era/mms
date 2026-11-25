# Migration review: 20261122T025953Z_fleet-ship-breakdown-node

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

None.

## Rollback strategy

```sql
DROP TABLE IF EXISTS fleet.ship_breakdown_node CASCADE;
```
