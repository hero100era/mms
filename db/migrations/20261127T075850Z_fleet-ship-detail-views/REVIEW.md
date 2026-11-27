# Migration review: 20261127T075850Z_fleet-ship-detail-views

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

- Enrich `api.ships` (`security_invoker = true`) with full `fleet.ship` classification, registration, tonnage, dimension, and status lookup columns while preserving all existing column names and positions.
- Add `security_invoker = true` API views for vessel details: `api.ship_parties`, `api.ship_class_notations`, `api.ship_certificates`, `api.ship_survey_audits`, `api.ship_finding_comments`, `api.ship_breakdowns`, `api.ship_breakdown_nodes`, and `api.ship_breakdown_node_particulars` with `SELECT` grants for `ext_user` and internal staff roles.
- Align `fleet.class_number_seq` `START WITH 10000` with `db/src/fleet/main.sql`.

## Destructive changes

None. All view updates and additions are additive.

## Rollback / forward-fix strategy

Forward-fix: All view updates and additions are additive and preserve existing `api.ships` column names and order.
Rollback: Drop the 8 new `api.ship_*` views and restore the prior `api.ships` view definition in a subsequent migration if needed.
