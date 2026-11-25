# Migration review: 20261106T050532Z_r1-2-document-create-acl

Scope: `docs/implementation_plan.md` R1.2 (completing the grant minimisation).

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: grants only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## Changes

`api.document_create_version` granted EXECUTE to `int_viewer` and
`int_compliance`, but its body raises `insufficient_privilege` for exactly those
two roles before doing any work, so the grant could never be exercised. This was
the one remaining grant-versus-body mismatch from the original R1.2 review; the
other three (document promotion, malware-scan recording, external-user
administration) were fixed in `20261106T025945Z_r1-r2-rectification`.

`ext_user` keeps the grant deliberately: it passes the org-membership branch for
its own organisation. `int_auditor`, `int_hr` and `int_finance` have no explicit
rejection in the body and remain constrained by `private.assert_in_scope`, so
they keep it too.

## Review metadata

**Security review: REQUIRED, not yet complete.** Per `AGENTS.md`, a grants change
needs the `security-review` label and two human reviewers before production
apply. Automated gates are green but do not substitute for that sign-off.

## Destructive changes

Two `REVOKE EXECUTE` statements removing grants that were never usable.

<!-- allow-destructive: REVOKE EXECUTE on api.document_create_version for int_viewer and int_compliance — R1.2 — the function body rejects both roles unconditionally, so the grant is unusable and only widens the exposed RPC surface; the in-body check remains as defence in depth -->
