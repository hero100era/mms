# ADR-0010: pgschema for declarative schema and migrations

- Status: accepted (F-03 spike; schema `USAGE` remains bootstrap-owned)
- Date: 2026-10-30

## Context

ADR-0003 abandoned the psqldef spike. The plan needs a declarative desired schema, reviewed migrations, drift detection and a repeatable local/CI pipeline.

## Decision

Use **pgschema 1.14.x** as the schema diff and migration generator:

- `db/src/` is the desired schema, one folder per schema; every `.sql` file in a folder is concatenated in name order for planning and applied in the same order when building the plan database.
- pgschema diffs the desired state against a plan database and writes a migration directory under `db/migrations/`.
- Migrations are reviewed and merged; production applies only reviewed migrations through the project runner.
- pgschema is not an approval mechanism. The C1–C8 checks and the schema lint run in CI and in the local gate.

## Spike results

Run with PostgreSQL 18.7 and pgschema 1.14.1 via `npm run db:spike` (`db/tests/pgschema/spike.ts`). Each fixture does add → alter → remove and re-plans to empty.

| Object type / behaviour | Result | Owner |
|---|---|---|
| Tables, columns, named constraints, indexes (partial and expression) | Managed; generated SQL converges | pgschema |
| Exclusion constraints with expressions using `btree_gist` | Managed | pgschema |
| Composite kind-checked FKs | Managed | pgschema |
| `default uuidv7()`, `default tstzrange(now(), null)`, `default clock_timestamp()` | Managed | pgschema |
| RLS enablement and policies calling `private.*` helpers | Managed; re-plan is stable | pgschema |
| Functions including `SECURITY DEFINER … SET search_path = ''`; argument-only signature change | Managed | pgschema |
| Triggers (`<table>_<purpose>`, function in `private`) | Managed | pgschema |
| Table, column and function grants converge | Managed; removing a grant produces the `REVOKE` | pgschema |
| `REVOKE ALL ON FUNCTION … FROM PUBLIC` | Managed, but pgschema emits `REVOKE EXECUTE` (equivalent) | pgschema |
| Schema `USAGE` grants | **Not tracked** — a desired `GRANT USAGE ON SCHEMA` produced no SQL | bootstrap |
| `security_invoker = true` views and their grants | Managed | pgschema |
| A view depending on a column whose type a migration alters | **Not automated** — pgschema emits `CREATE OR REPLACE VIEW` before `ALTER TABLE … TYPE`, and PostgreSQL still rejects the type change because the dependency remains; a reviewer must edit the generated migration to drop the view before the ALTER and recreate it after | hand-written |
| Cross-schema references (`iam` FK → `core`, `api` view → `core`, policy → `private`) | Managed through the external plan database | plan DB |
| Generated SQL qualification | pgschema emits unqualified names; the generator adds `set local search_path = <schema>;` per section | generator |
| Runner-created objects owned by `mms_owner` | C8 pgTAP check | runner + C8 |
| Rename via `pre.sql` | Generator accepts `--pre` and copies it into the migration; not exercised by a fixture | generator |
| Non-transactional statements | pgschema emits `CREATE INDEX CONCURRENTLY` plus a `-- pgschema:wait` poll; the generator strips the poll and splits the statement into `nontx.sql` | generator |

## Consequences

- The schema is readable as a declarative source.
- Drift is detected by diffing, not by manual comparison.
- Schema `USAGE` grants are bootstrap-owned; they must be reviewed with role changes, not with table changes.
- `pgschema:wait` polling is not a migration statement; the generator removes it so `nontx.sql` contains only executable DDL.
- A pgschema upgrade is a reviewed change with its own spike run.
- Remaining F-03 work before I-01: add the C4 previous-release fixture test; a view-column type change is a known manual-edit case and has no automated fixture.
