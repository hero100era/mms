# ADR-0011: Privilege-model PoC and API template

- Status: accepted as the M2 template; toy objects removed by a reviewed destructive migration
- Date: 2026-10-30

## Context

F-04 needed to prove the privilege model against a real PostgREST before IAM tables exist: location-scoped jobs, routed cases, an org tree with coverage, RLS, API views, invoker drafts, definer transitions and column grants.

## PoC shape

- `core.demo_org_unit` + `core.demo_org_coverage` — minimal tree and coverage.
- `party.demo_job(office_unit_id, …)` — location-scoped; `party.demo_case(handling_unit_id, …)` — routed.
- `private.demo_claim`, `private.demo_active_role`, `private.demo_my_units()` — JWT-claim helpers. `demo_my_units()` is `SECURITY DEFINER` and reads the coverage table; it returns the claim unit plus its covered units.
- RLS policies on both tables call `private.demo_my_units()`.
- `api.demo_jobs` and `api.demo_cases` are `security_invoker = true` views; only the exposed columns are granted.
- `api.demo_job_draft(text)` is `SECURITY INVOKER` and takes the unit from the claim, so a caller cannot choose another unit.
- `api.demo_job_submit(uuid)` is `SECURITY DEFINER`, checks `private.demo_active_role()` (never `current_user`), then checks the row is in `private.demo_my_units()`.
- Column grants on `party.demo_job` omit `internal_note`.

## Verification

Local PostgreSQL 18.6, PostgREST 16.4, HS256 JWT for the PoC (production uses ES256).

| Check | Result |
|---|---|
| Station scope sees its station's job and case only | Pass |
| Regional scope sees all covered stations | Pass |
| MTS scope sees covered stations | Pass |
| Plan-centre scope sees only its routed case | Pass |
| Global scope sees all | Pass |
| Base table (`party.demo_job`) unreachable through PostgREST | Pass — 404; only `api` is exposed |
| RLS applies through `security_invoker` views | Pass — counts match scope |
| Invoker draft cannot choose another unit | Pass — unit comes from the claim |
| Definer submit denies a row outside scope | Pass — `out_of_scope` |
| Definer submit denies a role without EXECUTE | Pass — 403 `permission denied for function` |
| Definer checks the claim role, not `current_user` | Pass — `SET ROLE int_surveyor` + claim `int_manager` succeeded |
| Column grant hides `internal_note` | Pass — direct table select denied; view does not expose it |
| Coverage change changes visibility at the next request | Pass |
| OpenAPI lists only intended objects | Pass — `demo_jobs`, `demo_cases`, `demo_job_draft`, `demo_job_submit` |
| Schema `USAGE` | Bootstrap-owned; pgschema does not track it (ADR-0010) |

## Template

1. Base tables in the owning domain schema, RLS enabled, no direct grants to capability roles except the column grants the API views need.
2. Scope helpers in `private`, `SECURITY DEFINER`, `SET search_path = ''`, explicit `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE` to the capability roles.
3. API views in `api`, `security_invoker = true`, exposing only the intended columns; grant `SELECT` on the view, not the table.
4. Drafts are invoker functions; transitions are definer functions with an explicit role check and an in-scope check. Both read claims through `private.*`, never `current_user`.
5. A coverage or routing change takes effect on the next statement; no cache in the policy path.

## Consequences

- The pattern is proven but the toy objects are not production schema. Remove them with a reviewed destructive migration (C2 annotation) before I-01.
- `internal_note` stays out of `api` and out of the capability-role column grants.
- The real `core` org tables and IAM scope helpers replace `demo_*` names in O-01/I-01.
