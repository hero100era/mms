# Migration review: 20261106T034303Z_r1-6-break-glass-matrix

Scope: `docs/implementation_plan.md` R1.6, ADR-0022 (proposed).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
      N/A: no destructive statements.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: one small reference table and function bodies.
- [x] Backfills are in `post.sql` and are idempotent. The matrix rows are seed data
      in `db/seed/020_iam_reference.sql` (`where not exists`), the repo's existing
      idempotent-seed convention; no `post.sql` is needed.
- [x] Regulated-data impact reviewed. No existing rows are rewritten. New audit
      event types are registered in `db/seed/010_core_reference.sql`.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

- `iam.break_glass_forbidden_action` — the explicit R1.6 matrix of operations a
  break-glass session may never perform (regulated approvals, signing, survey/
  audit conclusion, qualification approval, financial approval, HR decisions).
  RLS enabled, readable only by the definer, matching `iam.authority_rule`.
- `private.assert_not_break_glass(text)` — single enforcement point; raises
  `break_glass_forbidden_operation` (42501) and emits a denial event.
- `private.assert_authority` now calls it **before** the position lookup, so the
  prohibition is database-enforced even if an emergency account somehow acquired
  a staff position.
- `auth.break_glass_drill_record(uuid, text, text, jsonb)` — records a completed
  drill: updates `last_drill_at` and emits `auth.breakglass.drill_recorded` with
  operator, outcome and evidence. The sealed audit event is the evidence record.
  Granted only to `auth_gateway`.
- `break_glass_alert` outbox rows are now consumed by the worker
  (`apps/web/app/jobs/poller.ts`) and unrecognised kinds are marked `failed`
  instead of silently `done`.

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, changes to
authority rules, `SECURITY DEFINER` functions and the `auth` schema need the
`security-review` label and two human reviewers before production apply.
ADR-0022 is **proposed**, not accepted. Automated gates and pgTAP tests are
green but do not substitute for that sign-off.

## Destructive changes

None.

<!-- allow-destructive: none — R1.6 — no destructive statements in this migration -->
