# ADR-0020: Break-glass access is a dormant account, not a standing administrator (Card H-10)

- Status: proposed
- Date: 2026-11-03

## Context

The plan's Q2 answer requires a way back in when no administrator can sign in:
tenant lockout, a broken SSO configuration, an administrator suspended by mistake.
The obvious reading is "two spare `int_sysadmin` accounts". That reading gives away
the control it is trying to preserve. A standing global administrator whose only
protection is a password is an ordinary account with an alarming name: it is
reachable every day of the year, it never generates an event, and nobody notices
when it is used because it is always "on".

The specification in `docs/plans/auth-implementation-plan.md` section 12.6 asks for the
opposite shape: the account exists all the time, the **authority** exists for at most
four hours, and opening it is an event with a reason attached and two audiences
alerted. This ADR records the four decisions that make that shape work, because each
one is a place where a later change could quietly reintroduce a standing
administrator.

## Decisions

### 1. Dormancy is the absence of an assignment, enforced per request

`iam.break_glass_account` is a registry row, not a grant. A registered account holds
no `iam.role_assignment` at all until someone activates it. `private.pre_request()`
re-checks the caller's assignment on every PostgREST request, so a dormant account
cannot reach the API even though it can sign in. The session exists; the authority
does not.

The alternative, a standing assignment that the application hides until activated,
puts the decision in the web tier. Anything that mints a token, any forgotten route,
any test that bypasses the middleware, then has a live administrator behind it. The
gate is in the database because the database is what the token is checked against.

### 2. The window is carried in the signed token and re-checked against the clock

`auth.break_glass_activate` returns `{src: 'break_glass', bg: <epoch seconds>}`; the
BFF puts `src` and `bg` into the access token, and `private.pre_request()` refuses a
token whose `bg` has passed with `PT401 break_glass_expired` **before** it checks the
session or the assignment. Two consequences follow, and both are the point:

- Expiry needs no sweeper. There is no window between "the job should have run" and
  "the authority is gone".
- `private.audit_source()` attributes writes to `break_glass` only while a claim
  names an end in the future. A captured token degrades to its unprivileged default
  instead of claiming break-glass authority after the fact. The audit trail cannot
  be told a lie by replaying an old token, because the claim's own timestamp is what
  it is checked against.

The row is still the source of truth for "is there an assignment": the token says
*how long*, the row says *whether*. Both must agree, which is why
`auth.break_glass_claims` returns null unless a live assignment exists.

### 3. Break-glass authority stops at administration

A break-glass session runs as `int_sysadmin` and nothing else. It has no staff
position, so `private.assert_authority` refuses every regulated act with
`insufficient_authority`: staffing decisions, survey triage, document release,
finance approval. The emergency account can repair access; it cannot decide a
business question.

This is not a limitation to be worked around later. An account that can both restore
itself and approve the work it is restoring would be the single most valuable
credential in the system, and the four-hour window would bound how long it is
*convenient*, not how much it can do. The pgTAP suite asserts the refusal explicitly
(`db/tests/break_glass.sql`, "a break-glass account cannot make a staffing
decision").

### 4. Activating queues alerts; it does not rely on someone reading the audit trail

Activation inserts one `core.outbox` row per audience (`it_security`,
`ho_compliance`) in the same transaction as the assignment. If the alert cannot be
queued, activation fails: an unannounced break-glass window is worse than a closed
one. The spec's requirement that activation be noticed is therefore a property of
the transaction, not of a monitoring rule that can drift out of date.

Deactivation revokes the assignment **and every live session for the account**, then
returns the registry row to dormancy. The operator is signed out by design; there is
no "keep me signed in" path after the incident, because the session that existed was
only ever authorised by the window.

## Consequences

- The `iam.role_assignment` self-grant constraint (`granted_by <> user_id`) needed one
  narrow carve-out: a break-glass grant may name the account itself, but only when
  `source = 'break_glass'`, `db_role = 'int_sysadmin'` and `scope_type = 'global'`.
  The ordinary grant path still refuses a self-grant, and the test asserts it.
- `mms_emergency` is a separate, `nologin` database role for the case where the
  application is unreachable. It holds no capability role and no table privilege; it
  may execute four fixed runbook functions, each of which records its reason. It is a
  break-glass for the database, and it is deliberately not the same mechanism as the
  break-glass accounts, because the accounts need the application to work.
- The drill is a control with a clock: `last_drill_at` older than 100 days reports
  `drill_overdue` on the page and through `api.break_glass_state()`. An account that
  has not been exercised is an assumption, not a control.
- Not built here, and needed before production acceptance: recovery when *both*
  holders are unavailable, and the operational proof that the physical credential
  split is real. Those are process controls; the runbook names them, but code cannot
  enforce them.
