# Runbook: break-glass access (Card H-10)

Two emergency accounts exist so that a total loss of administrator access is
recoverable. They are **dormant by default**: an emergency account holds no role,
can reach exactly one page, and that page asks why. Activating it grants one global
`int_sysadmin` assignment for at most four hours, alerts IT security and HO
Compliance immediately, and records the reason on the assignment itself.

The design is in ADR-0020. The specification is
`docs/plans/auth-implementation-plan.md` section 12.6. This runbook is the part a human
needs at 03:00.

## What these accounts can and cannot do

They can: administer users, roles and organisation units; repair a lockout; restore
an administrator who was suspended by mistake.

They **cannot** approve business records. A break-glass session is an administrator
session and `private.assert_authority` finds no staff position behind it, so staffing
decisions, survey triage, document release and every other regulated act are refused
with `insufficient_authority`. This is deliberate: the account that exists to fix
access must never be able to decide a business question without a named person's
position behind it.

They cannot outlive their window. The end time is written into the signed access
token (`bg` claim) and re-checked by `private.pre_request` on every API call, so a
token stops working at the stated second even if the database row were left behind
and even if a background job never ran.

## Preconditions

- The emergency account's credentials are stored physically, separately from the
  ordinary administrator's, and are held by two different people. The account uses
  Entra sign-in with MFA; there is no local password for it.
- You can reach the application and you have the incident reference.
- You know which account is which: the registry is `iam.break_glass_account`, and the
  page shows the label so the wrong key is noticed before it is used.

## Steps

### 1. Sign in with the emergency identity

Sign in through the ordinary Entra flow. The account lands on `/break-glass`, not on
the dashboard: a dormant account has no role and no other page is reachable.

If the page says **activation is disabled**, stop. An administrator disabled this
account (`enabled = false`). That is intentional; see "Re-enabling" below. Do not
work around it.

### 2. State the reason

The reason field is required, must be at least ten characters, and is stored
verbatim in three places: the assignment's `grant_reason`, the audit event, and the
alert payload. Write what an auditor would need in six months: incident reference,
what is broken, who asked.

> INC-2026-0412: Entra tenant lockout, no int_sysadmin can sign in, on call since 02:40.

Press **Activate**. The window is four hours from that moment. Asking for longer
does not extend it; the request is clamped.

### 3. Tell the other holder

Both holders are alerted by the outbox (`it_security` and `ho_compliance` audiences),
but the second human holder is not. Message them. If the incident outlives you, they
must know the window is open before they are asked anything about it.

### 4. Do the minimum

Use the window for the access repair it was opened for. Do not use it for routine
administration, and do not use it to change the break-glass accounts themselves
without a second person watching: that is the one action that can quietly remove the
control.

### 5. Deactivate

Press **Deactivate** on `/break-glass` (or run the step below), giving the resolution
reason. Deactivation revokes the assignment, revokes **every live session** for the
account, and returns the registry row to dormancy. You are signed out by design.

```sql
-- Run as an administrator, not as the emergency account.
select auth.break_glass_deactivate(
  '00000000-0000-0000-0000-000000000000'::uuid,   -- the emergency user id
  'INC-2026-0412 resolved: administrator accounts restored'
);
```

### 6. Confirm it closed

```sql
select b.label, b.valid_until, b.reason,
       (select count(*) from iam.role_assignment a
         where a.user_id = b.user_id and a.source = 'break_glass'
           and a.revoked_at is null and a.valid @> now()) as live_assignments
  from iam.break_glass_account b;
```

Every row must show `live_assignments = 0` and a `valid_until` in the past. Then check
the audit trail for the activation, the actions taken inside the window, and the
deactivation:

```sql
select occurred_at, event_type, outcome, actor_id, reason
  from audit_trail.event
 where event_type like 'auth.breakglass.%'
 order by occurred_at desc
 limit 20;
```

Actions inside the window carry `source = 'break_glass'` in `audit_trail.change_log`, so
the reviewer can separate them from ordinary administration without guessing at
timestamps.

## Expiry without deactivation

If the window simply runs out, nothing is left to clean up: the token claim fails
(`break_glass_expired`), the assignment stops matching `now()`, and the account is
dormant again. Still record the resolution, because the audit trail should say how
the incident ended rather than leaving it to be inferred.

## Re-enabling a disabled account

Only a system administrator, through the registry:

```sql
update iam.break_glass_account set enabled = true where user_id = '...';
```

The update is captured by the audit trigger. When an account is disabled, whoever
disabled it must record why in the incident that caused it: the table has no
`disabled_reason` column by design, because a reason stored in a mutable row is not
evidence. The audit event is.

## The drill (quarterly)

Every emergency account must be exercised at least once every **100 days**. The
registry reports `drill_overdue` through the page and through
`api.break_glass_state()`, so an overdue account is visible without a scheduler.

To record a drill:

```sql
update iam.break_glass_account
   set last_drill_at = now()
 where user_id = '...';
```

A drill is a full activation and deactivation, not a sign-in: prove the credentials
work, prove the reason page appears, prove the alert reaches both audiences, prove
deactivation signs the account out. Record the timings in the log below.

## Drill log

| Date | Account | Activated by | Time to window | Deactivated | Notes |
|---|---|---|---|---|---|
| | | | | | |

## Emergency runbook (S3): the database role

When the application itself is unreachable, `mms_emergency` is the fixed, narrow
route. It is `nologin` by default, holds no capability role, and cannot read
`iam.app_user` or `audit_trail.event`. It can execute exactly four functions:

- `api.emergency_suspend_user(user_id, reason)`
- `api.emergency_revoke_sessions(user_id, reason)`
- `api.emergency_revoke_assignment(assignment_id, reason)`
- `api.emergency_reenable_break_glass(user_id, label, reason)`

Each refuses every caller that is not `mms_emergency` and each writes its reason to
the audit trail. To use it, a database administrator must first enable a login:

```sql
alter role mms_emergency login;   -- password set from the sealed envelope
```

Enabling and disabling the role is itself audited by the database (`pgaudit`
`role` logging), which is why the role may only be enabled by someone who is already
accountable for the incident. Disable it again as soon as the runbook is finished:

```sql
alter role mms_emergency nologin;
```

## Failure modes worth knowing

| Symptom | Cause | What to do |
|---|---|---|
| `/break-glass` says activation is disabled | `enabled = false` in the registry | Find the incident that disabled it; do not enable it yourself. |
| `already_holds_sysadmin` | Another live `int_sysadmin` assignment exists | You do not need break-glass. Deactivate if you already opened it, or wait for the other window to close. |
| `break_glass_requires_sysadmin_session` | The BFF created the session with a role other than `int_sysadmin` | A deployment bug, not an operator error: the login path must set `activeRole = 'int_sysadmin'` for these identities. |
| Activation succeeds but every page 403s | The access token predates the activation | Sign out and in again; the token is minted per request from the live window. |
| `insufficient_authority` on a staffing or survey action | Working as designed | A named position must make that decision. |
