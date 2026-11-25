# Migration review: 20261106T150811Z_r2-3-upload-state-machine

Scope: `docs/implementation_plan.md` R2.3 and R4.3, implementing ADR-0023
(decisions taken 2026-11-06 by the product/security owner).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
      N/A: no destructive statements.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: two new, empty tables.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration. The
      scanner-engine allowlist is reference data seeded by
      `db/seed/010_core_reference.sql` with `on conflict ... do update`, the repo's
      existing idempotent-seed convention.
- [x] Regulated-data impact reviewed. No document or audit rows are rewritten.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

- **`core.upload`** — the durable upload record ADR-0023 §1 chose (option (a)).
  One row per prepared destination, keyed by `uploadId`, carrying the
  server-computed `sha256`, byte size, MIME type repaired from the bytes, the
  server-generated `quarantine_path`, and an explicit `upload_state`
  (`prepared` -> `uploaded` -> `pending_scan` -> `clean`|`infected`|`error`, plus
  `abandoned` from the sweep). Constraints make the illegal states
  unrepresentable: only a `clean` row may name the `document_version_id` it
  produced, and only an approved engine may settle a verdict. RLS enabled;
  readable only through definer functions.
- **`private.approved_scanner_engine`** / **`private.is_approved_scanner(text)`** —
  replaces free-text `p_scanner_engine` with an allowlist (R7.3), so a caller
  cannot name an engine that does not exist, or the `mock`, to have an unscanned
  file marked clean.
- **`api.document_create_version`** — no longer infers `clean` from
  `p_storage_path`. Every version is created `pending` with no `scanned_at` and
  no upload link; it becomes `clean` only when the worker records the verdict
  (ADR-0023 §3 and §8). This is the change that closes the bypass: writing a
  non-quarantine path no longer buys a clean verdict, it buys an unscanned version.
- **`api.document_version_promote`** — refuses a version whose `scan_status` is
  not `clean` or whose `scanned_at` is null (`unscanned_document_cannot_be_promoted`,
  42501). Previously only `infected` was refused, so a never-scanned `pending`
  version could be promoted.

## Test-contract changes (deliberate)

- `db/tests/survey_request.sql` asserted that a *never-scanned* quarantined
  version could be promoted by an in-scope coordinator. That assertion encoded
  the defect. It now asserts the promotion is **rejected**, and a second
  assertion shows promotion succeeds after a recorded clean verdict. This is a
  rectification, not a weakened test.
- `apps/web/app/actions/malware-scan.test.ts` flows that promoted a pending
  version now record the scan verdict first.

## Review metadata

**Security review: REQUIRED, not yet complete.** New `SECURITY DEFINER` bodies,
grant changes and a new allowlist table. `AGENTS.md` requires the
`security-review` label and two human reviewers before production apply.
Automated gates are green and do not substitute for that sign-off.

## Destructive changes

None.

<!-- allow-destructive: none — R2.3 — additive tables, functions and grants; the only behaviour change is that promotion now requires a recorded clean verdict -->
