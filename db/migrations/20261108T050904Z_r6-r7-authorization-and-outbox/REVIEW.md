# Migration review: 20261108T050904Z_r6-r7-authorization-and-outbox

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION position_proposal_confirm — R6.3 — Sysadmin cannot approve HR proposals by virtue of sysadmin role -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION position_proposal_reject — R6.3 — Sysadmin cannot reject HR proposals by virtue of sysadmin role -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION staff_qualification_grant — R6.3 — Sysadmin cannot grant qualifications by virtue of sysadmin role -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION staff_qualification_revoke — R6.3 — Sysadmin cannot revoke qualifications by virtue of sysadmin role -->
<!-- allow-destructive: DROP FUNCTION IF EXISTS position_proposal_record — R6.3 — Signature updated with proposed_by parameter -->
<!-- allow-destructive: DROP FUNCTION IF EXISTS job_begin — R7.2 — Signature updated with lease_seconds and worker_id parameters -->
<!-- allow-destructive: DROP FUNCTION IF EXISTS job_complete — R7.2 — Signature updated with error_class and retry_delay parameters -->
<!-- allow-destructive: ALTER TABLE outbox DROP CONSTRAINT outbox_status_ck — R7.2 — Constraint replaced to include dead_letter status -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION job_begin — R7.2 — Replaced by new function signature -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION job_complete — R7.2 — Replaced by new function signature -->
<!-- allow-destructive: REVOKE EXECUTE ON FUNCTION position_proposal_record — R6.3 — Replaced by new function signature -->

## Rollback / forward-fix strategy

Forward-fix: The changes enforce segregation-of-duties and outbox durable leasing; forward fixes should preserve lease locks and SoD constraints.
Rollback: In emergency rollback, restore the previous function signatures; outbox leased items will naturally expire after lease timeout.
