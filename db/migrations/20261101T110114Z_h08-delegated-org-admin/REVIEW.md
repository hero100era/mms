# Migration review: 20261101T110114Z_h08-delegated-org-admin

- [ ] No renames outside `pre.sql`.
- [ ] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [ ] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [ ] Backfills are in `post.sql` and are idempotent.
- [ ] Regulated-data impact reviewed.
- [ ] `nontx.sql` statements are independent of the transactional part.
- [ ] Round-trip plan is empty (the generator checks this).

## Destructive changes

<!-- allow-destructive: <statement> — <ticket> — <reason> -->
