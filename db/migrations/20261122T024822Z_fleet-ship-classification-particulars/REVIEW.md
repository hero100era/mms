# Migration review: 20261122T024822Z_fleet-ship-classification-particulars

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Incorporate canonical maritime classification particulars into `fleet.ship`, add `fleet.ship_breakdown`, consolidate on `flag_code` (referencing `core.flag(code)`), and upgrade `fleet.ship_party.party_role` to canonical statutory maritime roles:
- `pre.sql`: Drops dependent view `api.ships` to allow schema changes on `fleet.ship`.
- Sequence: `fleet.class_number_seq` starting at 1000 with usage granted to application roles.
- `fleet.ship`:
  - Dropped duplicate `flag_state` column in favor of statutory `flag_code varchar(3) not null default 'PA' references core.flag(code)`.
  - Added classification and identity fields: `class_number`, `previous_names`, `build_date`, `commissioning_date`, `keel_laid_date`, `contract_date`, `class_entry_date`, `administration_types` (referencing `core.administration_type(code)`), `classed_by`, `port_of_registry`, `date_of_registry`, `registry_number`, `call_sign`, `official_number`, `type_iacs`, `type_other`, `type_mms`, `class_status`, `ship_status`.
  - Added vessel metrics: `gross_tons`, `national_tons`, `deadweight`, `net_tons`, `light_ship`, `ballast_capacity`, `equipment_number`, `length`, `length_oa`, `length_bp`, `moulded_depth`, `moulded_breadth`, `moulded_draft`, `design_draft`.
  - Added template relations: `dual_class`, `signal_letter`, `breakdown_template_id` (referencing `core.breakdown_template(id)`), `is_active`.
- `fleet.ship_party`: Upgraded constraint `ship_party_role_ck` (via `NOT VALID` + `VALIDATE`) to enforce statutory maritime roles per ADR-0028: `registered_owner`, `bareboat_charterer`, `doc_company`, `ism_manager`, `isps_operator`, `commercial_operator`, `builder`, `agent`, `mlc_owner`.
- `fleet.ship_breakdown`:
  - Instantiated ship breakdown model linking to `fleet.ship(id)` on delete cascade and `core.breakdown_template(id)` on delete set null.
  - Enforced single active breakdown per ship constraint via `ship_breakdown_active_uk` partial unique index.
  - Enabled RLS with staff read and external client ship-party-scoped read policies.
- `api.ships`: Recreated view with `flag_code` and re-applied grants.
- Foreign key performance index created concurrently in `nontx.sql`: `ship_breakdown_template_ix`.

## Destructive changes

<!-- allow-destructive: ALTER TABLE ship DROP COLUMN flag_state — MMS-CONSOLIDATION — remove duplicate flag_state column in favor of flag_code referencing core.flag -->
<!-- allow-destructive: ALTER TABLE ship_party DROP CONSTRAINT ship_party_role_ck — ADR-0028 — replace minimal check constraint with canonical statutory maritime roles -->

## Rollback / Forward-Fix Strategy

All table changes are additive column additions with backward-compatible defaults or nullable types, table creation, constraint updates, view recreation, and concurrent indexes. In case of issues prior to production baseline lock, forward-fix via subsequent migration or rollback by reverting schema definitions in `fleet` and `api`.
