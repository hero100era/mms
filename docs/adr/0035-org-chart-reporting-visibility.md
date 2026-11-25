# ADR-0035: Org Chart Reporting Visibility and Org-Unit Hierarchy

- Status: proposed
- Date: 2026-11-25
- Context: Supporting a Microsoft Teams-style organization chart across MMS internal staff, incorporating structural patterns from `002_iclass_organization.sql`.
- Related: ADR-0006 (schema boundaries), ADR-0008 (four-dimension auth), ADR-0010 (pgschema), ADR-0017 (caller identity in definer functions), `docs/plans/auth-implementation-plan.md` (Card I-06, Card I-10).

## Context

In Card I-10 (`docs/plans/auth-implementation-plan.md` and `db/tests/rls_matrix.csv`), `api.user_directory` hid both compensation `grade` and `line_manager_id` from all internal roles except `int_hr`, self, and a user's line manager (`private.my_reports()`).

To render a Microsoft Teams-style organization chart for internal staff—showing upward management chains, peers sharing a manager, direct/indirect reports, and the organizational unit tree—all internal staff need read access to reporting lines (`line_manager_id` and org-chart traversal views/functions). At the same time, compensation `grade`, position change reasons, and direct base-table access to `iam.staff_position` and `iam.job_title.grade` must remain strictly restricted.

## Decision

1. **Internal visibility of reporting lines (changing Card I-10 `line_manager_field` rule):**
   - `private.user_directory_line_manager(uuid)` returns `line_manager_id` for any authenticated internal capability role (`int_viewer`, `int_surveyor`, `int_auditor`, `int_coordinator`, `int_manager`, `int_compliance`, `int_hr`, `int_finance`, `int_sysadmin`), and `NULL` otherwise.
   - `api.org_chart_nodes` (`security_invoker = true`) and org-chart RPCs (`api.org_chart_management_chain`, `api.org_chart_reports`, `api.org_chart_peers`, `api.org_chart_for_user`) are granted strictly to the internal capability roles and expose active/invited internal staff reporting relationships without exposing compensation `grade` or `entra_object_id`.
   - Direct table column grants (`iam.staff_position.line_manager_id`, `iam.job_title.grade`), `api.staff_positions`, and `private.user_directory_grade(uuid)` remain restricted as established in Card I-10 (`int_hr` for base columns and `api.staff_positions`; `int_hr`, self, and `private.my_reports()` for `grade`).
   - `ext_user` and `web_anon` remain strictly denied on `api.user_directory`, `api.org_unit_hierarchy`, `api.org_chart_nodes`, and all `api.org_chart_*` functions.

2. **Materialized `ltree` org-unit hierarchy (`core.org_unit`):**
   - Add `level` and `path` (`extensions.ltree`, indexed with GiST) to `core.org_unit`, maintained automatically by `private.org_unit_tree_check()` and `private.org_unit_path_cascade()`.
   - Expose `api.org_unit_hierarchy` (`security_invoker = true`) for internal staff with full breadcrumb path, ancestor IDs/codes, and active staff counts.

## Consequences

- Requires `security-review` approval because it modifies `private.user_directory_line_manager(uuid)` and adds `SECURITY DEFINER` org-chart traversal functions and `api` views.
- `db/tests/rls_matrix.csv` and `db/tests/rls_matrix.sql` are updated so `line_manager_field` expects `allow` for internal roles while preserving `grade_field`, `staff_position`, `ext_user`, and `web_anon` denials.
- All org-chart recursive queries include explicit cycle guards (`not (user_id = any(visited))`) and depth caps.
