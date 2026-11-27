# Migration review: 20261127T043849Z_align-column-compatibility

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

allow-destructive: ALTER COLUMN TYPE on core.breakdown_template_node_particular.attr_key, fleet.ship_breakdown_node.category, fleet.certificate.doc_administration, and survey.certificate_line.doc_administration — COLUMN-COMPAT — Non-destructive widening (varchar(20)->varchar(100), varchar(50)->varchar(100)) and char(3)->varchar(3) alignment with core.flag(code).

## Rollback / forward-fix strategy

Forward-fix: Additive FK constraints, concurrent indexes, widened column widths, and `NOT NULL` alignment are backward-compatible for valid rows.
Rollback: Drop `certificate_doc_admin_ix`, `certificate_line_doc_admin_ix`, `certificate_doc_admin_fk`, `certificate_line_doc_admin_fk`, and `ship_breakdown_node_particular_data_type_not_null`, then revert column types if needed before any >20-char `attr_key` or >50-char `category` data is written.
