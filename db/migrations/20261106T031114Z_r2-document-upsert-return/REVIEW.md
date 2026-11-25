# Migration review: 20261106T031114Z_r2-document-upsert-return

Scope: `docs/implementation_plan.md` R2.1 (follow-up to
`20261106T025945Z_r1-r2-rectification`).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
      N/A: no destructive statements.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: one function body only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten by this migration.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

`api.document_create_version` used
`INSERT ... ON CONFLICT DO UPDATE ... WHERE title IS DISTINCT ... RETURNING id`.
When the title was unchanged the `WHERE` clause skipped the update, `RETURNING`
produced no row, and `v_doc_id` stayed NULL — the following version insert then
failed with a not-null violation on `document_id`. Removing the conditional makes
the upsert always return the logical document id, so repeated revisions with the
same file name (S-03) work and the unique constraint still serialises concurrent
first uploads.

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, changing a
`SECURITY DEFINER` function body needs the `security-review` label and two human
reviewers before production apply. Automated checks and pgTAP tests are green
but do not substitute for that sign-off.

## Destructive changes

None.

<!-- allow-destructive: none — R2.1 — no destructive statements in this migration -->
