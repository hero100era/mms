# Migration review: 20261124T020111Z_wave2-data-and-audit-closure

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Phase Wave 2 Data and Audit Closure:
- **Core Catalogue & Breakdown Models:** Normalizes `core.breakdown_template`, `core.breakdown_template_node`, `core.checklist_item_particular` types and constraints, enables RLS and audit capture across catalogue entities.
- **Flag Access Control:** Revokes direct `flag` table select from `ext_user` and grants column-level access to non-sensitive columns (`code`, `fullname`, `is_active`, `is_hssc`, `name`).
- **Malware Scan Run:** Revokes unnecessary insert/select on `audit_trail.malware_scan_run` from coordinator/manager roles, restricts insert policy to `int_sysadmin, worker`, grants select to `audit_sealer`.
- **Audit Trail & Immutability:** Adds `row_key` column to `audit_trail.change_log`, adds no-truncate triggers across audit tables, updates append-only and purge functions for retention management.
- **Fleet Ship Breakdown:** Drops legacy single-column parent node FK and establishes composite foreign key constraints.

## Destructive changes

<!-- allow-destructive: ALTER TABLE checklist_item_particular ALTER COLUMN checklist_item_id TYPE integer — WAVE-2 — Normalize checklist_item_id foreign key type -->
<!-- allow-destructive: ALTER TABLE breakdown_template DROP CONSTRAINT breakdown_template_code_key — WAVE-2 — Relax template code unique constraint for multi-tenancy/versioning -->
<!-- allow-destructive: ALTER TABLE breakdown_template_node DROP CONSTRAINT breakdown_template_node_parent_node_id_fkey — WAVE-2 — Replace single-column parent FK with composite template constraint -->
<!-- allow-destructive: ALTER TABLE ship_breakdown_node DROP CONSTRAINT ship_breakdown_node_parent_node_id_fkey — WAVE-2 — Replace single-column parent FK with composite breakdown constraint -->
<!-- allow-destructive: REVOKE SELECT ON TABLE flag FROM ext_user — WAVE-2 — Restrict external user access to column-level grant -->
<!-- allow-destructive: REVOKE INSERT, SELECT ON TABLE malware_scan_run FROM int_coordinator, int_manager — WAVE-2 — Restrict security scan tables to sysadmin and worker roles -->
<!-- allow-destructive: REVOKE USAGE ON SEQUENCE class_number_seq FROM ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer — WAVE-2 — Sequence usage lockdown -->

## Rollback / forward-fix strategy

Forward-fix: Apply corrective migration to restore previous constraint or grant configurations if necessary.
Rollback: Revert by re-adding dropped constraints, restoring table-level grants, and re-applying previous function definitions.
