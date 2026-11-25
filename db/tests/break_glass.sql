begin;
set search_path = extensions, public;

-- Card H-10 (Q2 = yes, ADR-0020): break-glass access.
--
-- The point of this file is the control, not the feature. A break-glass account is
-- worth having only if it is dormant until someone says why, grants exactly one
-- bounded sysadmin window, cannot approve business records, and leaves a record that
-- survives the incident. Each assertion below is one of those guarantees.
select plan(43);

\i db/fixtures/org.sql

-- Two emergency identities (the spec asks for two, guarded by separate keys), one
-- ordinary system administrator, and one manager with a real position, used to show
-- that break-glass authority does not extend to business approvals.
-- The tenant must be the one `auth.config` names, or `resolve_entra` refuses the
-- identity as foreign before any break-glass logic runs.
insert into auth.config (singleton, entra_tenant_id)
values (true, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict (singleton) do update set entra_tenant_id = excluded.entra_tenant_id;

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
select v.id, 'internal', v.display_name, c.entra_tenant_id, v.id, 'active'
  from auth.config c,
       (values
         ('e1000000-0000-0000-0000-000000000001'::uuid, 'Emergency One'),
         ('e1000000-0000-0000-0000-000000000002'::uuid, 'Emergency Two'),
         ('e1000000-0000-0000-0000-000000000003'::uuid, 'Ordinary Sysadmin'),
         ('e1000000-0000-0000-0000-000000000004'::uuid, 'Duty Manager')
       ) as v(id, display_name)
 where c.singleton;

insert into iam.break_glass_account (user_id, label) values
  ('e1000000-0000-0000-0000-000000000001', 'Emergency key one'),
  ('e1000000-0000-0000-0000-000000000002', 'Emergency key two');

-- The manager holds a position, so `assert_authority` can succeed for them; that is
-- what makes the refusal in test 4 meaningful rather than trivially unreachable.
insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000101', 'e1000000-0000-0000-0000-000000000004',
       'internal', 'managers', 'management', u.id,
       tstzrange(now() - interval '1 day', now() + interval '30 days'),
       'e1000000-0000-0000-0000-000000000003', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

-- 1. Dormant means no authority at all: no assignment exists.
select is(
  (select count(*) from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000001'),
  0::bigint, 'a break-glass account holds no assignment while dormant');

select is(
  (auth.resolve_entra(
     (select entra_tenant_id from iam.app_user where id = 'e1000000-0000-0000-0000-000000000001'),
     'e1000000-0000-0000-0000-000000000001', null, null, array['MMS.User']
   ) ->> 'break_glass')::boolean,
  true, 'resolve_entra tells the BFF this identity is a break-glass account');

-- A dormant session exists but PostgREST refuses it, because the gate re-checks the
-- assignment on every request rather than trusting the cookie.
insert into iam.session (id, user_id, user_kind, active_role, auth_method,
                         idle_expires_at, expires_at)
values ('e1000000-0000-0000-0000-000000000201', 'e1000000-0000-0000-0000-000000000001',
        'internal', 'int_sysadmin', 'entra', now() + interval '30 minutes',
        now() + interval '4 hours');

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'e1000000-0000-0000-0000-000000000001',
  'sid', 'e1000000-0000-0000-0000-000000000201',
  'role', 'int_sysadmin'
)::text, true);

select throws_ok(
  $$select private.pre_request()$$,
  'PT401', 'session_invalid',
  'a dormant break-glass session is refused by the pre-request gate');

select is(
  (auth.break_glass_claims('e1000000-0000-0000-0000-000000000001')),
  null::jsonb, 'a dormant account contributes no break-glass token claims');

-- The page the account lands on must be readable while it has no authority, or the
-- account that exists to break a lockout would be locked out itself.
select is(
  auth.break_glass_state('e1000000-0000-0000-0000-000000000001') ->> 'dormant',
  'true', 'the break-glass page can read its own dormant state');

-- 2. Activation: exactly one assignment, global, bounded, recorded, alerted.
select is(
  (auth.break_glass_activate('e1000000-0000-0000-0000-000000000001',
     'production outage, no administrator reachable') ->> 'activated')::boolean,
  true, 'activation succeeds with a reason');

select is(
  (select count(*) from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000001'
      and source = 'break_glass' and db_role = 'int_sysadmin' and scope_type = 'global'),
  1::bigint, 'activation creates exactly one global int_sysadmin assignment');

select is(
  (select grant_reason from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000001' and source = 'break_glass'),
  'production outage, no administrator reachable',
  'the reason is stored with the assignment, not only in the event');

select cmp_ok(
  (select extract(epoch from (upper(valid) - lower(valid))) from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000001' and source = 'break_glass'),
  '<=', 14400::numeric,
  'the window never exceeds four hours');

-- The second account asks for nine hours and must not get them.
select is(
  (auth.break_glass_activate('e1000000-0000-0000-0000-000000000002',
     'second incident', now() + interval '9 hours') ->> 'activated')::boolean,
  true, 'the second account can open its own window');

-- The requested end is clamped, not honoured. The comparison uses the stored
-- activated_at rather than now(): the window is measured from clock_timestamp() so an
-- incident cannot be extended by a long-running transaction.
select is(
  (select b.valid_until <= b.activated_at + interval '4 hours'
     from iam.break_glass_account b
    where b.user_id = 'e1000000-0000-0000-0000-000000000002'),
  true, 'a longer requested window is clamped to four hours');

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.breakglass.activated'
      and subject_id = 'e1000000-0000-0000-0000-000000000001'),
  1::bigint, 'the activation is written to the audit trail');

select is(
  (select count(*) from core.outbox
    where kind = 'break_glass_alert'
      and payload ->> 'user_id' = 'e1000000-0000-0000-0000-000000000001'),
  2::bigint, 'IT security and HO Compliance are both alerted through the outbox');

select is(
  (select array_agg(distinct payload ->> 'audience' order by payload ->> 'audience')
     from core.outbox where kind = 'break_glass_alert'
      and payload ->> 'user_id' = 'e1000000-0000-0000-0000-000000000001'),
  array['ho_compliance', 'it_security'],
  'the two alerts name different audiences');

-- A second activation does not stack a second assignment.
select is(
  (auth.break_glass_activate('e1000000-0000-0000-0000-000000000001',
     'still the same incident') ->> 'reason'),
  'already_active', 'a repeat activation reports the open window instead of stacking');

select is(
  (select count(*) from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000001' and source = 'break_glass'),
  1::bigint, 'a repeat activation leaves exactly one assignment');

-- Self-grant is allowed only in this shape: the I7 exception is narrow.
select throws_ok(
  $$select api.role_assignment_grant(
      'e1000000-0000-0000-0000-000000000001', 'int_sysadmin', 'global', null, 'self grant attempt')$$,
  '42501', 'cannot_grant_self',
  'the ordinary grant path still refuses a self-grant');

-- 3. Expiry is enforced by the request gate, not by a sweeper.
-- The lower bound moves back too: the live row starts at the activation instant,
-- which is this transaction's now(), so closing it in place would invert the range.
update iam.role_assignment
   set valid = tstzrange(now() - interval '2 hours', now() - interval '1 second', '[)')
 where user_id = 'e1000000-0000-0000-0000-000000000001' and source = 'break_glass';

select throws_ok(
  $$select private.pre_request()$$,
  'PT401', 'session_invalid',
  'after the window closes the next request is refused');

update iam.role_assignment
   set valid = tstzrange(now() - interval '1 minute', now() + interval '1 hour', '[)')
 where user_id = 'e1000000-0000-0000-0000-000000000001' and source = 'break_glass';

-- A token that names an end in the past is refused even while the row is live: the
-- claim cannot outlive its window just because a row survived.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'e1000000-0000-0000-0000-000000000001',
  'sid', 'e1000000-0000-0000-0000-000000000201',
  'role', 'int_sysadmin',
  'src', 'break_glass',
  'bg', floor(extract(epoch from now()))::bigint - 60
)::text, true);

select throws_ok(
  $$select private.pre_request()$$,
  'PT401', 'break_glass_expired',
  'a break-glass token whose own window has passed is refused');

-- With a live window and a matching claim the same request passes.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'e1000000-0000-0000-0000-000000000001',
  'sid', 'e1000000-0000-0000-0000-000000000201',
  'role', 'int_sysadmin',
  'src', 'break_glass',
  'bg', floor(extract(epoch from now() + interval '1 hour'))::bigint
)::text, true);

select lives_ok(
  $$select private.pre_request()$$,
  'a live window with a matching claim passes the gate');

select is(
  private.audit_source(), 'break_glass',
  'actions taken inside the window are attributed to break-glass, not to the web tier');

-- 4. Break-glass authority stops at administration: no business approval.
select throws_ok(
  $$select api.staff_position_set(
      'e1000000-0000-0000-0000-000000000004', 'managers',
      (select id from core.org_unit where code = 'CN-EAST-S1'), null, null, now(),
      'position set under break-glass authority')$$,
  '42501', 'break_glass_forbidden_operation',
  'a break-glass account cannot make a staffing decision (ADR-0022 explicit matrix)');

select is(
  (select count(*) from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000003'),
  0::bigint, 'the ordinary administrator starts with no role');

-- 5. Ordinary administration still works while a window is open.
insert into iam.role_assignment (id, user_id, user_kind, db_role, scope_type, source, valid, granted_by, grant_reason)
values ('e1000000-0000-0000-0000-000000000301', 'e1000000-0000-0000-0000-000000000003',
        'internal', 'int_sysadmin', 'global', 'manual',
        tstzrange(now() - interval '1 minute', now() + interval '1 day'),
        'e1000000-0000-0000-0000-000000000004', 'ordinary grant during an incident');

select ok(
  exists (select 1 from iam.role_assignment
           where id = 'e1000000-0000-0000-0000-000000000301' and revoked_at is null),
  'an ordinary int_sysadmin grant is unaffected by an open break-glass window');

-- 6. Deactivation closes the window and revokes the sessions that used it.
select is(
  auth.break_glass_deactivate('e1000000-0000-0000-0000-000000000001',
    'incident resolved, service restored'),
  1, 'deactivation revokes the one assignment');

select is(
  (select count(*) from iam.role_assignment
    where user_id = 'e1000000-0000-0000-0000-000000000001'
      and source = 'break_glass' and revoked_at is null),
  0::bigint, 'no live break-glass assignment survives deactivation');

select is(
  (select count(*) from iam.session
    where user_id = 'e1000000-0000-0000-0000-000000000001' and revoked_at is null),
  0::bigint, 'deactivation revokes every live session for the account');

select is(
  (select reason from iam.break_glass_account
    where user_id = 'e1000000-0000-0000-0000-000000000001'),
  null::text, 'the account returns to dormancy with no recorded window');

-- 7. The drill is a control: an overdue one is visible without a scheduler.
update iam.break_glass_account
   set last_drill_at = now() - interval '93 days'
 where user_id = 'e1000000-0000-0000-0000-000000000002';

select is(
  (auth.break_glass_state('e1000000-0000-0000-0000-000000000002') ->> 'drill_overdue')::boolean,
  true, 'an account not drilled in over 92 days (quarterly) reports an overdue drill');

update iam.break_glass_account
   set last_drill_at = now() - interval '30 days'
 where user_id = 'e1000000-0000-0000-0000-000000000002';

select is(
  (auth.break_glass_state('e1000000-0000-0000-0000-000000000002') ->> 'drill_overdue')::boolean,
  false, 'a recent drill clears the overdue flag');

-- The per-caller flag is only read when a human opens the page, which is exactly what does
-- not happen while the account is dormant, so the scheduler needs a set-returning scan.
-- Account two was just drilled (30 days) and is not reported. Account one was never
-- drilled at all, and a null last_drill_at is the most overdue state there is, not a
-- quiet one, so the scan must still carry it.
select is(
  (select count(*) from auth.break_glass_drill_overdue()),
  1::bigint, 'a never-drilled account stays overdue after another account is drilled');

update iam.break_glass_account
   set last_drill_at = now() - interval '95 days'
 where user_id = 'e1000000-0000-0000-0000-000000000001';

select is(
  (select count(*) from auth.break_glass_drill_overdue()),
  1::bigint, 'the scan reports exactly the account whose drill lapsed (> 92 days)');

select is(
  (select user_id from auth.break_glass_drill_overdue()),
  'e1000000-0000-0000-0000-000000000001'::uuid, 'the scan names that account');

-- R8.5: Break-glass synchronous denial and asynchronous cleanup
-- Activate account one, create a session, then manually expire valid_until
select auth.break_glass_activate('e1000000-0000-0000-0000-000000000001', 'testing expiry sync denial');
insert into iam.session (id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
values ('e1000000-0000-0000-0000-000000000999', 'e1000000-0000-0000-0000-000000000001',
        'internal', 'int_sysadmin', 'entra', now() + interval '1 hour', now() + interval '8 hours');

-- Simulating expired window: valid_until in the past
update iam.break_glass_account
   set activated_at = now() - interval '5 hours',
       valid_until = now() - interval '1 hour'
 where user_id = 'e1000000-0000-0000-0000-000000000001';

-- Set claims as break_glass account with active session
select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'int_sysadmin',
  'sub', 'e1000000-0000-0000-0000-000000000001',
  'sid', 'e1000000-0000-0000-0000-000000000999'
)::text, true);

select throws_ok(
  'select private.pre_request()',
  'PT401',
  'break_glass_expired',
  'private.pre_request() immediately and synchronously denies expired break-glass activation'
);

-- Asynchronous cleanup: auth.break_glass_sweep_expired() revokes the session and resets account
select is(
  auth.break_glass_sweep_expired(),
  1,
  'auth.break_glass_sweep_expired() sweeps exactly the expired break-glass account'
);

select is(
  (select revoked_at is not null from iam.session where id = 'e1000000-0000-0000-0000-000000000999'),
  true,
  'asynchronous cleanup marks lingering physical session as revoked'
);

select is(
  (select activated_at is null and valid_until is null from iam.break_glass_account where user_id = 'e1000000-0000-0000-0000-000000000001'),
  true,
  'asynchronous cleanup resets break_glass_account activation state'
);

-- R8.5: Transactional security alert enqueuing
select ok(
  private.enqueue_security_alert('SEAL_TAMPER_DETECTED', 'CRITICAL', 'audit_sealer', 'r8_5_break_glass_pgtap_test', '{"seal": 1}'::jsonb) is not null,
  'private.enqueue_security_alert() enqueues security alert into core.outbox'
);

select is(
  (select count(*) from core.outbox where kind = 'security_alert' and payload ->> 'message' = 'r8_5_break_glass_pgtap_test'),
  1::bigint,
  'core.outbox contains the enqueued security alert'
);

-- S3: the database emergency role may only run the fixed runbook, and only while an
-- administrator has enabled it. It holds no capability role, so it cannot SET ROLE.
select is(
  (select rolcanlogin from pg_roles where rolname = 'mms_emergency'),
  false, 'the mms_emergency login is disabled by default');

select is(
  (select count(*) from pg_auth_members m
     join pg_roles r on r.oid = m.member
    where r.rolname = 'mms_emergency'),
  0::bigint, 'mms_emergency holds no capability role, so it cannot SET ROLE into one');

select ok(
  not has_table_privilege('mms_emergency', 'iam.app_user', 'select')
  and not has_table_privilege('mms_emergency', 'audit_trail.event', 'select'),
  'mms_emergency cannot read app users or the audit trail directly');

select ok(
  has_function_privilege('mms_emergency', 'api.emergency_suspend_user(uuid, text)', 'execute')
  and has_function_privilege('mms_emergency', 'api.emergency_revoke_sessions(uuid, text)', 'execute'),
  'mms_emergency may execute the fixed runbook functions');

rollback;
