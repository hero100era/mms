# ADR-0008: four authorization dimensions

- Status: accepted
- Date: 2026-10-30

## Context

A single role check cannot express who may do what, where, and with which qualification. The plan needs independent dimensions that can be evaluated and audited separately.

## Decision

Authorize on four dimensions:

1. **Capability role** — what the principal is allowed to do (for example `inspector`, `supervisor`, `admin`).
2. **Scope** — which organizational or location boundary the action applies to.
3. **Position** — the principal's appointed position and its authority.
4. **Qualification** — the training, certification or delegation required for the specific action.

A request is allowed only when all four checks pass. The BFF mints the active capability role; the database enforces scope, position and qualification through policies and transition functions. Role switching changes only the active capability role, never the underlying grants.

## Consequences

- Policies are composable and each dimension can be tested in isolation.
- A missing dimension is a bug, not an implicit allow.
- Audit records must capture the role and the scope used for the decision.
