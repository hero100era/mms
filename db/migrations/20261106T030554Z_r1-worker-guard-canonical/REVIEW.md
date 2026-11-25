# Migration review: 20261106T030554Z_r1-worker-guard-canonical

Scope: `docs/implementation_plan.md` R1.1 (follow-up to
`20261106T025945Z_r1-r2-rectification`).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
      N/A: no destructive statements.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: function bodies only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten; only caller
      authorization inside SECURITY DEFINER functions is made fail-closed.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

Adds `private.is_worker_or_admin()` and replaces eight duplicated inline guards
with it. The inline form `if not (private.is_worker() or private.active_role()
= 'int_sysadmin')` fails open for a direct call without JWT claims: `active_role()`
is NULL, so `false OR NULL` is NULL, `NOT NULL` is NULL, and PL/pgSQL skips the
IF branch. The helper coalesces the claim to `''` in one reviewed location, so
every privileged maintenance function denies an unauthenticated direct caller.

`private.record_malware_scan_run` (from the preceding migration) now uses the
same canonical helper.

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, changing
`SECURITY DEFINER` function bodies and authority-adjacent caller checks needs
the `security-review` label and two human reviewers before production apply.
Automated checks and pgTAP tests are green but do not substitute for that
sign-off.

## Destructive changes

None.

<!-- allow-destructive: none — R1.1 — no destructive statements in this migration -->
