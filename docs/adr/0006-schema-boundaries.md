# ADR-0006: schema boundaries

- Status: accepted
- Date: 2026-10-30

## Context

A single shared schema would let unrelated modules couple through tables, grants and functions. The plan needs schemas that follow domain ownership, access boundaries and lifecycle rather than one schema per table.

## Decision

Create one schema per **domain, access boundary or lifecycle**, not one schema for the whole application. Each schema has an owning module and an explicit public surface:

- Tables stay private to the schema.
- Cross-module access goes through `api` views or documented `private` functions, never by granting on another module's tables.
- The `auth` schema is reserved for the gateway session and credential functions.
- A schema change that adds a cross-schema dependency needs an ADR or an explicit note in the migration.

## Consequences

- Grants, policies and RLS are scoped to a small surface.
- Module ownership is visible in the schema name.
- Cross-module queries need an explicit interface rather than an ad hoc join.
