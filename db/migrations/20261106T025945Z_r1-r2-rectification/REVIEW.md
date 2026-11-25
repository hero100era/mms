# Migration review: 20261106T025945Z_r1-r2-rectification

Scope: `docs/implementation_plan.md` R1.1, R1.2, R2.1, R2.2.

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: `core.document` is empty in the reviewed snapshot (0 rows, verified); the
      unique constraint is additive and takes a brief ACCESS EXCLUSIVE lock only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration needed;
      duplicate logical documents were checked for and none exist.
- [x] Regulated-data impact reviewed. No rows are rewritten; `core.document` gains a
      uniqueness invariant and revision allocation is serialised.
- [x] `nontx.sql` statements are independent of the transactional part. N/A: no `nontx.sql`.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

- `private.is_emergency()` — canonical caller-class helper; the four
  `api.emergency_*` runbook functions now use it instead of repeating the
  `'mms_emergency'` literal (R1.1).
- `private.record_malware_scan_run()` — added the worker/sysadmin guard its
  sibling definer functions already have (R1.1, ADR-0017).
- ACL minimisation: revoked EXECUTE from roles that are always rejected inside
  the function body (`api.create_external_user`, `api.invite_external_user`,
  `api.document_version_promote`, `api.document_version_record_scan`) (R1.2).
- `core.document_logical_uk UNIQUE (entity_type, entity_id, doc_type)` and an
  atomic `INSERT ... ON CONFLICT DO UPDATE` in
  `api.document_create_version` (R2.1).
- Logical-document row lock before `max(revision_no) + 1` and a stable
  `document_revision_conflict` (SQLSTATE 40001) on an impossible duplicate (R2.2).

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md` this migration
changes grants, `SECURITY DEFINER` function bodies and authority-adjacent
caller checks, so it needs the `security-review` label and two human reviewers
before it is applied to production. The automated gate (`db:lint`, `db:check`,
`db:spike`, `db:test`, `db:verify`) and pgTAP tests are green, but that does
not substitute for the human sign-off.

## Destructive changes

Only `REVOKE EXECUTE` statements that remove over-broad grants. They do not
remove data, columns, tables, constraints, policies or functions.

<!-- allow-destructive: REVOKE EXECUTE on api.create_external_user/invite_external_user/document_version_promote/document_version_record_scan for int_viewer, ext_user, int_compliance, int_coordinator, int_manager — R1.2 — these roles are always denied inside the function body, so the grant is misleading and widens the exposed RPC surface; the database check remains as defence in depth -->
