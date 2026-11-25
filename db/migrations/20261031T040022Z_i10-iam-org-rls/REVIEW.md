# Migration review: 20261031T040022Z_i10-iam-org-rls

- [ ] No renames outside `pre.sql`.
- [ ] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [ ] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [ ] Backfills are in `post.sql` and are idempotent.
- [ ] Regulated-data impact reviewed.
- [ ] `nontx.sql` statements are independent of the transactional part.
- [ ] Round-trip plan is empty (the generator checks this).

## Destructive changes

allow-destructive: REVOKE SELECT ON TABLE staff_position FROM int_sysadmin; — I-10 — restrict position management and salary/grade inspection strictly to int_hr
allow-destructive: REVOKE SELECT ON TABLE staff_positions FROM int_sysadmin; — I-10 — restrict position view access strictly to int_hr
