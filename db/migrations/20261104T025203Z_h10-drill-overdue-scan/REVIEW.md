# Migration review: 20261104T025203Z_h10-drill-overdue-scan

- [x] No renames outside `pre.sql`. (Adds one function; no renames.)
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason. (None: this only creates.)
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`. (No index or constraint changes.)
- [x] Backfills are in `post.sql` and are idempotent. (No backfill.)
- [x] Regulated-data impact reviewed. Reads `iam.break_glass_account` (`label`, `last_drill_at`, `enabled`) and returns no identity, session or credential data. It lives in the `auth` gateway schema, which PostgREST does not expose (`PGRST_DB_SCHEMAS=api`), so no browser-reachable surface grows and the `api` schema is untouched. It joins the existing `auth.break_glass_*` family reviewed under ADR-0020 (Card H-10) and needs the two-reviewer `security-review` gate for that reason, not a new one.
- [x] `nontx.sql` statements are independent of the transactional part. (No `nontx.sql`.)
- [x] Round-trip plan is empty (the generator checks this; it printed `round trip is clean`).

## Destructive changes

None.
