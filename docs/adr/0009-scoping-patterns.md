# ADR-0009: two scoping patterns

- Status: accepted
- Date: 2026-10-30

## Context

Some records belong to the office or location that owns them. Others are routed work items that move between handling units while their originating location stays fixed. Using one column for both makes scope checks ambiguous.

## Decision

Use two explicit scoping columns:

- `office_unit_id` — the location or office that **owns** the record. This is the scope used for location-based access.
- `handling_unit_id` — the unit currently **responsible** for routed work. This changes as work moves.

A record may have both. Policies must state which column they use, and transition functions update `handling_unit_id` without rewriting `office_unit_id`.

## Consequences

- Location scope and work routing are independent.
- Moving work does not silently change ownership.
- Every policy and view must name the scoping column it relies on.
