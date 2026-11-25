# Migration review: 20261030T111600Z_f04-cleanup

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [ ] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [ ] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed: only toy F-04 objects; no production data.
- [ ] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Destructive changes

<!-- allow-destructive: all statements — F-04 — remove the toy privilege-model PoC after the template ADR is recorded -->
