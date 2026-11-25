# ADR-0024: Idempotency keys and stable domain error codes (R2.4, R3.4)

- Status: proposed
- Date: 2026-11-06

## Context

`docs/plans/rectification-implementation-plan.md` R2.4 asks for idempotency keys where external
retries are expected and stable domain error codes rather than human message
parsing. R3.4 asks for SQLSTATE conventions and controller mappings for
400/401/403/404/409/500.

Current state: the five survey transition RPCs already lock the workflow row
`FOR UPDATE`, validate the state after locking and emit the audit event in the
same transaction. They do **not** use a state predicate on `UPDATE`, do not
verify exactly one row changed, and there is no idempotency key anywhere in
`db/src`. `packages/pgrst-client` has an `idempotencyKey` option that `rpc()`
never forwards, and `requestContext()` strips inbound `Idempotency-Key` headers.
Controllers make authorization decisions from error message substrings
(`err.message?.includes('step_up_required')` etc.).

## Decisions still required

1. **Key ownership.** Who generates the idempotency key (browser, BFF, or
   database), where it is stored, how long it is retained, and which replay
   returns the original result rather than a conflict. A `core.idempotency_key`
   table or per-workflow column are the candidates.
2. **SQLSTATE convention.** A table of domain codes → SQLSTATE (e.g.
   `invalid_state` → 22023, `conflict` → 40001/23505, `insufficient_authority`
   → 42501) and a rule that PostgREST surfaces a machine-readable `code` field.
   Controllers must stop parsing message text.
3. **Header policy.** Whether inbound `Idempotency-Key` remains a stripped
   BFF-owned header (current) or becomes a trusted, validated value. The current
   strip is deliberate; changing it needs a threat-model review.

## What is implemented without this ADR

R2.4's unambiguous half is already done independently of idempotency: each
transition `UPDATE` gets a `where id = p_id and status = <expected>` predicate
and a `GET DIAGNOSTICS` / exactly-one-row check. Those changes introduce no new
convention and are covered by pgTAP tests. Idempotency keys and error-code
mapping remain open until this ADR is approved.

## Review

Requires ADR approval and a security review for any change to `SECURITY DEFINER`
transition RPCs.
