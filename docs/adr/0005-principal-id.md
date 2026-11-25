# ADR-0005: principal identity

- Status: accepted
- Date: 2026-10-30

## Context

Users can arrive through Entra, external identity providers or local credentials. Email addresses change and are not unique across tenants.

## Decision

The audit and authorization actor is `iam.app_user.id`. Staff identities are bound by the Entra `(tid, oid)` pair **from a validated ID token**. External identities are bound by `(issuer, subject)`. Email is never an identity key.

## Consequences

- Identity linking and deduplication use stable provider identifiers.
- The BFF must validate the ID token before trusting `tid` or `oid`.
- Changing an email address does not change the principal.
