# ADR-0017: Caller identity inside `SECURITY DEFINER` functions

- Status: proposed
- Date: 2026-11-01
- Applies to: every function in `db/src`, the schema lint (`db/scripts/lint-schema.ts`), the worker
  process and the PostgREST request path.

## Context

The database enforces privileged operations with `SECURITY DEFINER` functions in `private`
(and a few in `auth`). Several of them are meant to be callable only by the background worker
process: the outbox claim/completion pair, the Entra deprovisioning sync, and the malware
scan ledger. They guarded that with the obvious-looking check:

```sql
if session_user <> 'worker' then
  raise exception 'worker_role_required' using errcode = '42501';
end if;
```

That check does not work, and it failed open rather than closed.

While a `SECURITY DEFINER` function runs, PostgreSQL switches the execution context to the
function owner. Both `session_user` and `current_user` therefore evaluate to the definer —
`mms_owner` here — regardless of who called the function. The guard compared `mms_owner` to
`'worker'`, which is false, so the `raise` never fired. Every caller that already held the
`EXECUTE` grant passed the check, including any PostgREST capability role (`int_coordinator`,
`int_manager`, `int_sysadmin`) whose JWT and session were valid.

The consequences were concrete:

| Function | What an authorised-but-wrong caller could do |
|---|---|
| `private.deprovision_staff_user` | Close every position of any staff member and revoke their sessions, i.e. lock a colleague out of the system |
| `private.entra_sync_list_staff` | Enumerate the full staff directory including Entra object IDs |
| `private.record_entra_sync_run` | Write false "sync succeeded" rows into the deprovisioning ledger |
| `private.document_version_record_scan` | Assert a malware verdict for a file that was never scanned, and move it out of quarantine |
| `private.list_pending_quarantine_scans` | Enumerate every quarantined upload |
| `private.record_malware_scan_run` | Forge entries in the malware scan ledger |

A second, independent problem made the same class of bug likely to recur: the identity a
function needs depends on *how* the caller was authenticated, and there are three different
mechanisms in play.

## Decision

1. **Never compare `session_user` or `current_user` inside a function body.** The schema lint
   rejects both tokens in any `$$…$$` body under `db/src` except `db/src/private/main.sql`
   (where the helper below has to inspect them). `current_user` in a column default is still
   allowed, because a default is evaluated in the inserting session, not in the definer.

2. **Resolve the caller through `private.caller_role()`**, which recovers the identity from the
   only three places it survives, in this order:

   | Signal | Set by | Seen as |
   |---|---|---|
   | `role` GUC (not `''`/`'none'`) | `SET ROLE` / `SET LOCAL ROLE` | the target role — PostgREST's `SET LOCAL ROLE int_*` |
   | `session_user` ≠ `current_user` | `SET SESSION AUTHORIZATION` | the original login role — the worker process |
   | `current_user` | nothing else applies | the definer itself |

   The GUC wins because an in-session role switch is the most specific statement of intent.

3. **Express intent with `private.is_worker()`**, not with a role string. A PostgREST request
   can never satisfy it: PostgREST always authenticates as `authenticator` and switches to a
   capability role, so the GUC names that role and `session_user` is `authenticator`.
   `private.pre_request()` independently refuses a `worker`-role JWT (`PT403 role_not_allowed`),
   so the two layers do not share a single point of failure.

4. **Guards are proven, not assumed.** Every privileged function needs a pgTAP test that calls
   it as a PostgREST-shaped caller (`set local role int_sysadmin` after
   `set local role authenticator`) and asserts the denial. `db/tests/auth.sql` has the
   regression block for this ADR.

## Consequences

- The worker-only functions now actually deny staff callers. Nothing in the application called
  them through a capability role, so no feature regressed.
- `private.caller_role()` leaks the raw role string of the caller into audit columns
  (`audit_trail.event.db_role`, `audit_trail.malware_scan_run.scanned_by`, `audit_trail.seal.sealed_by`). That is
  the intended attribution and matches what the actor columns already recorded.
- The lint rule flags legitimate uses of `current_user` inside a helper body. That is deliberate:
  forced reliance on the helper keeps the trap from being reintroduced by a well-meaning
  refactor.
- The three-signal helper is PostgreSQL-specific and documented in one place. A future change to
  how the worker authenticates (for example, moving it to its own connection pool with a
  different login role) must update `private.is_worker()` and the regression tests together.

## Alternatives considered

- **`SET SESSION AUTHORIZATION` on every worker call.** Rejected: it needs superuser, and our
  worker login is deliberately not a superuser.
- **Grant `EXECUTE` only to the worker and rely on privileges alone.** Rejected: the capability
  roles must not be able to call these functions, but `grant` errors are opaque in application
  logs and a future grant would silently reopen the hole. The explicit guard plus the lint rule
  keeps the intent visible at the definition site.
- **A `mms.caller` custom GUC set by the middleware.** Rejected as the primary mechanism: the
  value would be settable by any caller unless every connection opened it, so it adds a forging
  surface instead of removing one.
