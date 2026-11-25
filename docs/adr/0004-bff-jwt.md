# ADR-0004: BFF-issued JWT

- Status: accepted
- Date: 2026-10-30

## Context

PostgREST is the data API, but the browser must not hold database credentials or call PostgREST directly. The BFF already owns the user session and the authorization context.

## Decision

The browser never calls PostgREST. The BFF mints a short-lived **ES256** JWT (maximum 5 minutes) for the active human capability role and calls PostgREST over a private network. PostgREST holds public keys only. Tokens carry the minimum claims needed by the database and are not stored in browser-readable state.

## Consequences

- The browser only talks to the BFF.
- Token signing keys stay server-side; `token-signer.ts` and `gateway-client.ts` are server-only modules.
- A compromised BFF is still high impact, so signing keys and gateway credentials need separate protection and rotation.
