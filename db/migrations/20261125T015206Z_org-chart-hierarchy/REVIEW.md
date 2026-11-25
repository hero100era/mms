# Migration review: 20261125T015206Z_org-chart-hierarchy

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

allow-destructive: REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC; — ADR-0035 — Revoke default PUBLIC EXECUTE on new private/api org-chart functions (no role grants are removed; regex matches subsequent GRANT ... TO int_*).

## Rollback / forward-fix strategy

Forward-fix: Additive org-unit `level`/`path` columns, GiST/btree indexes, `api.org_unit_hierarchy`, `api.org_chart_nodes`, and `api.org_chart_*` traversal functions are forward-compatible.
Rollback: Drop the added `api.org_chart_*` functions, `api.org_chart_nodes`, `api.org_unit_hierarchy`, `core.org_unit_path_cascade`, restore previous `private.org_unit_tree_check` and `private.user_directory_line_manager` definitions, and drop `level`/`path` columns and indexes if required.
