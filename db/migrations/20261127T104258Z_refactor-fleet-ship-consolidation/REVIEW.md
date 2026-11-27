# Migration review: 20261127T104258Z_refactor-fleet-ship-consolidation

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

- Consolidate `fleet.ship` operational status onto a single `status varchar(20)` FK referencing `core.ship_status (code)` (widening `core.ship_status.code` to `varchar(20)` and seeding canonical status values `'in_service'`, `'laid_up'`, `'under_construction'`, `'decommissioned'` in `pre.sql`), removing duplicate `ship_status` and `ship_status_ck`.
- Consolidate gross tonnage onto `gross_tonnage decimal(9, 2)` and remove duplicate `gross_tons`.
- Remove free-text `ship_type` in favor of canonical `type_iacs` (`core.vessel_type_iacs`) and `type_mms` (`core.vessel_type_mms`, non-null default `'OC'`).
- Rename `administration_types` to `administration_type` referencing `core.administration_type (code)`.
- Rebuild `api.ships` (`security_invoker = true`) exposing `type_iacs`, `type_iacs_name`, `type_mms`, `type_mms_name`, `administration_type`, `gross_tonnage`, and `ship_status_name`.

## Destructive changes

allow-destructive: ALTER TABLE fleet.ship DROP COLUMN ship_type / administration_types / gross_tons; — REFACTOR-SHIP — Removed duplicate free-text/tonnage columns and plural typo in favor of `type_iacs`/`type_mms`, `administration_type`, and `gross_tonnage`.
allow-destructive: ALTER TABLE fleet.ship ALTER COLUMN gross_tonnage / status TYPE ...; — REFACTOR-SHIP — Standardized `gross_tonnage` to `numeric(9,2)` and `status` to `varchar(20)` FK referencing `core.ship_status`.
allow-destructive: ALTER TABLE fleet.ship DROP CONSTRAINT ship_gross_tonnage_ck; — REFACTOR-SHIP — Recreated check constraint cleanly for `numeric(9,2)` type.

## Rollback / forward-fix strategy

Forward-fix: Add corrective columns, lookups, or view projections in a subsequent forward migration if needed.
Rollback: Re-add `ship_type`, `ship_status`, `gross_tons`, and `administration_types` on `fleet.ship`, revert `core.ship_status` codes, and restore the prior `api.ships` view in a subsequent migration.
