# ADR-0022: An explicit break-glass forbidden-operations matrix (R1.6)

- Status: proposed
- Date: 2026-11-06

## Context

`docs/plans/rectification-implementation-plan.md` R1.6 requires an explicit matrix of operations
forbidden to break-glass authority, enforced in database authority functions
rather than only in UI/controllers. Today the prohibition is **implicit**: a
break-glass account may not hold a staff position (`api.break_glass_register`),
and `private.assert_authority()` raises `insufficient_authority` with
`reason = 'no_position'` when no position exists. ADR-0020 §3 documents this as
the intended mechanism, but no code enumerates the R1.6 list, so a future RPC
that checks authority differently (or a future change that grants positions to
emergency accounts) would silently lose the control.

The plan's forbidden list: regulated approvals, certificate/report signing,
survey conclusion, audit conclusion, qualification approval, financial approval,
and HR decisions. Several of these are not yet implemented as RPCs (they belong
to R9); the matrix must exist *before* those RPCs are written.

## Decisions

1. The matrix is a table, `iam.break_glass_forbidden_action`, with one row per
   forbidden `action_code` and a human-readable `description`. It is seed data,
   not code, so adding a new regulated operation is a reviewed migration plus a
   seed row rather than a change to an authority function.
2. `private.assert_not_break_glass(p_action_code text)` is the single enforcement
   point. It raises `break_glass_forbidden_operation` (SQLSTATE 42501) when both
   (a) `private.audit_source() = 'break_glass'` and (b) the action code is in the
   matrix. It emits an `authz.denied.break_glass_forbidden` audit event.
3. `private.assert_authority()` calls `assert_not_break_glass` **first**, before
   the position lookup. Every regulated operation goes through
   `assert_authority`, so the prohibition is database-enforced even if a future
   account somehow acquires a position.
4. Platform administration actions are deliberately **not** in the matrix:
   break-glass exists to restore the platform (`api.emergency_*`, user suspend,
   session/assignment revoke). Those remain available.
5. Codes for operations not yet implemented are reserved explicitly
   (`certificate.issue`, `certificate.sign`, `report.sign`,
   `survey.conclude`, `audit_trail.conclude`, `qualification.approve`,
   `financial.approval`) so R9 cannot accidentally route them around the matrix.
   Their semantics are R9 ADRs; this ADR only reserves their prohibition.

## Consequences

- A forged `src = 'break_glass'` JWT claim causes *more* denials, never fewer, so
  relying on the signed claim is safe in the fail-closed direction.
- `private.audit_source()` returns `break_glass` only while the token's `bg`
  claim is in the future; an expired break-glass session is already refused by
  `private.pre_request()` and degrades to an ordinary caller.
- Break-glass accounts still cannot hold positions; this ADR adds defence in
  depth, it does not replace that invariant.
- The quarterly drill/evidence workflow and outbox alert retry are separate
  proposals (R7.2 and the R1.6 drill task), not part of this ADR.

## Review

Requires the `security-review` label and two reviewers (authority rules,
`SECURITY DEFINER`). Do not apply outside development until signed off.
