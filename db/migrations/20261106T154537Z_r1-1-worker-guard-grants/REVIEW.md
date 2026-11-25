# Migration review: 20261106T154537Z_r1-1-worker-guard-grants

Scope: `docs/implementation_plan.md` R1.1 — correct an ordering and privilege
defect introduced by `20261106T030554Z_r1-worker-guard-canonical`.

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: function bodies and grants only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## The defect

`private.is_worker_or_admin()` was defined as:

```sql
select private.is_worker()
    or coalesce(private.active_role(), '') = 'int_sysadmin';
```

The `worker` login is not a capability role: it holds no EXECUTE on
`private.claims()` or `private.active_role()`. SQL does not promise
short-circuit evaluation for `OR`, so for a caller where the first operand was
true the second operand could still be planned/executed, and PostgreSQL rejected
the whole call with:

```
permission denied for function active_role
```

The helper therefore raised for exactly the caller it exists to admit (the
worker) instead of returning true. `db/tests/pre_request.sql` caught it. The
intent (fail closed) was right, but the construction could not deliver it,
because "closed" became "error" for a legitimate caller.

A second defect was an ordering problem: the `grant execute on function
private.active_role()` line was placed before the function definition, so the
schema failed to build (`function private.active_role() does not exist`).

## The fix

- Re-write `private.is_worker_or_admin()` in PL/pgSQL with an explicit
  `if private.is_worker() then return true; end if;` **before** the sysadmin
  branch. PL/pgSQL evaluates statements lazily, so the worker never reaches the
  `active_role()` call.
- Add an `insufficient_privilege` exception handler that returns `false`. A
  caller which cannot execute `active_role()` is, by definition, not the
  sysadmin role. This keeps the helper fail-closed for every other
  caller even if a future grant is removed, instead of converting a deny into an
  error.
- Move `grant execute on function private.active_role() to worker` to after the
  function definition, so the schema builds.

## Verification

- `db/tests/rectification_r1_1.sql` still returns `false` and denies for a direct,
  claimless call.
- `db/tests/pre_request.sql` worker coverage passes again.
- A direct `worker` connection now returns `true`.

## Review metadata

**Security review: REQUIRED, not yet complete.** This changes a function body and
adds a grant. `AGENTS.md` requires the `security-review` label and two human
reviewers before production apply. Automated gates are green and do not
substitute for that sign-off.

## Destructive changes

None.

<!-- allow-destructive: none — R1.1 — function replacement plus one additive GRANT; no objects are removed -->
