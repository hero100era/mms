# Migration review: 20261106T053409Z_r1-1-emit-event-owner-only

Scope: `docs/implementation_plan.md` R1.1 and R1.2 — audit-trail integrity.

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
      N/A: grants only.
- [x] Backfills are in `post.sql` and are idempotent. N/A: no data migration.
- [x] Regulated-data impact reviewed. No rows are rewritten or deleted.
- [x] `nontx.sql` statements are independent of the transactional part. N/A.
- [x] Round-trip plan is empty (the generator checks this).

## The defect

`private.emit_event()` is SECURITY DEFINER and stamps `audit_trail.event.db_role` from
`coalesce(nullif(c ->> 'role', ''), private.caller_role())`, where `c` is
`current_setting('request.jwt.claims')`. On the PostgREST path the claim is the
JWT's, so it is trustworthy. But the function was also granted EXECUTE to
`int_sysadmin` and `int_compliance`, and a caller that holds those capability
roles — or that can act through them in any path the gate does not cover —
supplies `request.jwt.claims` itself.

Demonstrated before this change (all inside one transaction):

```
set local role int_sysadmin;
select set_config('request.jwt.claims',          -- caller-chosen
  '{"sub":"...","role":"worker"}', true);;
select private.emit_event('authz.denied...');    -- executed
select db_role from audit_trail.event order by occurred_at desc limit 1;
--> worker                                        -- forged attribution
```

Any holder of `int_sysadmin` or `int_compliance` could therefore write audit rows
attributing an action to `worker`, `int_sysadmin`, another capability role, or a
different `sub`. That defeats the point of an append-only, sealed trail: the
record is honest about the event but not about who caused it. `privileges.sql`
asserted that `PUBLIC` has no EXECUTE, which is true, and did not catch this.

## The fix

Revoke EXECUTE on `private.emit_event(...)` from `int_compliance` and `int_sysadmin`.
The function is still reachable in both legitimate ways:

- `private.audit_capture()` and `private.stamp()` call it from inside
  `SECURITY DEFINER` triggers that execute as `mms_owner`; and
- `auth.emit_event()` (`db/src/auth/main.sql`) calls it from an `auth_gateway`
  definer function, so the BFF's authenticated-event path is unaffected.

`mms_owner` keeps its implicit grant, so the owner can still invoke it directly
for maintenance — an owner connection is already trusted to impersonate anyone
and is not exposed through PostgREST.

## Verification

- `db:tests/rectification_r1_1.sql` now asserts that `int_sysadmin` cannot call
  `private.emit_event` directly (catches 42601/42501) and that the audit trail
  cannot be given an arbitrary `db_role` by a capability role.
- The full suite confirms the trigger path and `auth.emit_event` still write
  events.

## Review metadata

**Security review: REQUIRED, not yet complete.** This narrows grants on an audit
writing primitive; per `AGENTS.md` it needs the `security-review` label and two
human reviewers before production apply. Effective gates are green but do not
substitute for that sign-off.

## Destructive changes

Two `REVOKE EXECUTE` statements removing direct-write authority from capability
roles.

<!-- allow-destructive: REVOKE EXECUTE on private.emit_event from int_compliance and int_sysadmin — R1.1/R1.2 — a direct caller supplies its own request.jwt.claims, letting any holder of those roles forge db_role and sub on the append-only audit trail; the SECURITY DEFINER trigger path (mms_owner) and auth.emit_event (auth_gateway) remain the only legitimate callers -->
