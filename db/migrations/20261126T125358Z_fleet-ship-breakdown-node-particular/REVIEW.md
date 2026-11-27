# Migration review: 20261126T125358Z_fleet-ship-breakdown-node-particular

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

None. Additive table `fleet.ship_breakdown_node_particular` with identity primary key, FKs to `fleet.ship_breakdown_node` and `core.breakdown_template_node_particular`, RLS policies, and audit capture trigger.

## Rollback / forward-fix strategy

Forward-fix: Additive table, indexes, RLS policies, and audit capture trigger are forward-compatible.
Rollback: Drop table `fleet.ship_breakdown_node_particular` (along with its indexes, policies, and trigger) if rollback is required before data depends on it.
