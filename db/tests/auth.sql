begin;
set search_path = extensions, public;

insert into auth.config (singleton, entra_tenant_id)
values (true, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict (singleton) do update set entra_tenant_id = excluded.entra_tenant_id;

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values
  ('11111111-1111-1111-1111-111111111111', 'internal', 'Actor',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'internal', 'Other',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'active');

insert into iam.app_user (id, kind, display_name, email, status)
values
  ('33333333-3333-3333-3333-333333333333', 'external', 'External', 'external@example.com', 'active'),
  ('44444444-4444-4444-4444-444444444444', 'external', 'Invitee', 'invitee@example.com', 'invited');

insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
values ('11111111-1111-1111-1111-111111111111', 'int_coordinator', 'global', 'manual',
        '22222222-2222-2222-2222-222222222222', 'test');

select plan(85);

select has_table('auth', 'config', 'auth.config exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.prokind = 'f'),
  45::bigint, 'auth has 45 gateway functions');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.prokind = 'f'
      and not has_function_privilege('auth_gateway', p.oid, 'EXECUTE')),
  0::bigint, 'auth_gateway can execute every auth function');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.prokind = 'f'
      and has_function_privilege('int_viewer', p.oid, 'EXECUTE')),
  0::bigint, 'int_viewer cannot execute auth functions');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.prokind = 'f'
      and has_function_privilege('ext_user', p.oid, 'EXECUTE')),
  0::bigint, 'ext_user cannot execute auth functions');

select is(has_table_privilege('int_viewer', 'auth.config', 'SELECT'), false,
          'capability roles cannot read auth.config');

select throws_ok(
  $$select auth.resolve_entra('99999999-9999-9999-9999-999999999999',
      'dddddddd-dddd-dddd-dddd-dddddddddddd', 'x@example.com', 'X', array['MMS.User'])$$,
  '42501', 'foreign_tenant', 'foreign tenant is rejected');

select throws_ok(
  $$select auth.resolve_entra('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'dddddddd-dddd-dddd-dddd-dddddddddddd', 'x@example.com', 'X', array['Guest'])$$,
  '42501', 'mms_user_role_required', 'guest without MMS.User is rejected');

select throws_ok(
  $$select auth.resolve_entra('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'dddddddd-dddd-dddd-dddd-dddddddddddd', 'x@example.com', 'X', array['MMS.User', 'Guest'])$$,
  '42501', 'guest_denied', 'guest with MMS.User is rejected');

select is(
  auth.resolve_entra('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'dddddddd-dddd-dddd-dddd-dddddddddddd', 'new@example.com', 'New User',
    array['MMS.User']) ->> 'status',
  'active', 'resolve_entra JIT-creates an active internal user');

select is(
  (select count(*) from iam.role_assignment a join iam.app_user u on u.id = a.user_id
    where u.entra_object_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  0::bigint, 'resolve_entra never grants a role');

select is(
  (select count(*) from iam.staff_position p join iam.app_user u on u.id = p.user_id
    where u.entra_object_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  0::bigint, 'resolve_entra never sets a position');

select is(auth.resolve_external('microsoft', 'https://issuer', 'subject-1') ->> 'status',
          'not_linked', 'unknown external identity is not linked');

select is(auth.password_lookup('unknown@example.com') ->> 'status', 'unknown',
          'unknown password login is generic');

select is(auth.password_lookup('external@example.com') ->> 'status', 'active',
          'known external login is found');

select throws_ok(
  $$select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'int_viewer',
      '127.0.0.1', 'test')$$,
  '42501', 'external_session_requires_ext_user', 'external sessions must use ext_user');

select throws_ok(
  $$select auth.session_create('11111111-1111-1111-1111-111111111111', 'entra', 'int_manager',
      '127.0.0.1', 'test')$$,
  '42501', 'role_not_assigned', 'internal sessions need a current assignment');

select auth.session_create('11111111-1111-1111-1111-111111111111', 'entra', 'int_coordinator',
  '127.0.0.1', 'test') ->> 'session_id' as actor_sid \gset

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'test') ->> 'session_id' as external_sid \gset

select is(auth.session_read(:'actor_sid'::uuid) ->> 'active_role', 'int_coordinator',
          'session_read returns the active role');

select throws_ok(
  format('select auth.session_set_role(%L, %L)', :'actor_sid', 'int_manager'),
  '42501', 'role_not_assigned', 'session_set_role rejects an unassigned role');

select throws_ok(
  format('select auth.token_issue(%L, %L, %L)',
    '44444444-4444-4444-4444-444444444444', 'invite', :'external_sid'),
  '42501', 'insufficient_authority', 'a non-coordinator cannot invite');

select auth.token_issue('44444444-4444-4444-4444-444444444444', 'invite',
  :'actor_sid'::uuid) as invite \gset

select is(
  (select auth.token_consume('invite', :'invite'::jsonb ->> 'token') ->> 'user_id'),
  '44444444-4444-4444-4444-444444444444',
  'invite token is consumed once');

select is(auth.token_consume('invite', :'invite'::jsonb ->> 'token'), null::jsonb,
          'invite token cannot be replayed');

select auth.token_issue('44444444-4444-4444-4444-444444444444', 'invite',
  :'actor_sid'::uuid) as invite2 \gset

select is(
  auth.set_password(:'invite2'::jsonb ->> 'token', repeat('x', 32)) ->> 'user_id',
  '44444444-4444-4444-4444-444444444444',
  'invite token sets a password');

select is(
  (select status from iam.app_user where id = '44444444-4444-4444-4444-444444444444'),
  'active', 'invite acceptance activates the user');

select is(
  (select count(*) from iam.password_credential
    where user_id = '44444444-4444-4444-4444-444444444444'),
  1::bigint, 'invite acceptance stores a password credential');

select throws_ok(
  format('select auth.link_identity(%L, %L, %L, %L, %L, null, null)',
    :'external_sid', 'microsoft', 'https://issuer', 'subject-1', 'external@example.com'),
  '42501', 'step_up_required', 'linking requires a recent step-up');

select auth.session_write(:'external_sid'::uuid, jsonb_build_object('stepUpAt', now()));

select lives_ok(
  format('select auth.link_identity(%L, %L, %L, %L, %L, null, null)',
    :'external_sid', 'microsoft', 'https://issuer', 'subject-1', 'external@example.com'),
  'linking with step-up succeeds');

select is(auth.resolve_external('microsoft', 'https://issuer', 'subject-1') ->> 'status',
          'linked', 'linked identity resolves');

select throws_ok(
  format('select auth.link_identity(%L, %L, %L, %L, %L, null, null)',
    :'external_sid', 'microsoft', 'https://issuer', 'subject-1', 'external@example.com'),
  '23505', null, 'duplicate active link is rejected');

select id as identity_id from iam.user_identity
 where issuer = 'https://issuer' and subject = 'subject-1' \gset

select throws_ok(
  format('select auth.unlink_identity(%L, %L)', :'external_sid', :'identity_id'),
  '42501', 'last_sign_in_method', 'unlinking the last sign-in method is refused');

select is(
  auth.set_password(:'external_sid'::text, repeat('y', 32)) ->> 'user_id',
  '33333333-3333-3333-3333-333333333333',
  'a session can set its own password');

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'test') ->> 'session_id' as external_sid2 \gset

select auth.session_write(:'external_sid2'::uuid, jsonb_build_object('stepUpAt', now()));

select lives_ok(
  format('select auth.unlink_identity(%L, %L)', :'external_sid2', :'identity_id'),
  'unlink succeeds when a password remains');

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'test') ->> 'session_id' as external_sid3 \gset

select auth.token_issue('33333333-3333-3333-3333-333333333333', 'password_reset',
  :'actor_sid'::uuid) as reset \gset

select auth.set_password(:'reset'::jsonb ->> 'token', repeat('z', 32));

select is(
  (select count(*) from iam.session
    where user_id = '33333333-3333-3333-3333-333333333333' and revoked_at is null),
  0::bigint, 'password reset revokes all sessions');

select auth.session_create('11111111-1111-1111-1111-111111111111', 'entra', 'int_coordinator',
  '127.0.0.1', 'test') ->> 'session_id' as actor_sid2 \gset

select auth.session_revoke_all(:'actor_sid'::uuid);

select is(
  (select count(*) from iam.session
    where user_id = '11111111-1111-1111-1111-111111111111' and revoked_at is null),
  0::bigint, 'session_revoke_all revokes every session');

select auth.log_event('auth.login.failure', 'failure',
  '33333333-3333-3333-3333-333333333333', jsonb_build_object('reason', 'test'));

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.login.failure'
      and subject_id = '33333333-3333-3333-3333-333333333333'),
  1::bigint, 'log_event records a pre-session failure');

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'test') ->> 'session_id' as external_sid4 \gset

select is(
  (select count(*) from auth.user_identities(:'external_sid4'::uuid)),
  0::bigint, 'user_identities reflects unlinked state after unlink');

insert into iam.app_user (id, kind, display_name, email, status)
values ('55555555-5555-5555-5555-555555555555', 'external', 'OAuth Invitee', 'oauth_invitee@example.com', 'invited');

select auth.session_create('11111111-1111-1111-1111-111111111111', 'entra', 'int_coordinator',
  '127.0.0.1', 'test') ->> 'session_id' as actor_sid3 \gset

select auth.token_issue('55555555-5555-5555-5555-555555555555', 'invite', :'actor_sid3'::uuid) as oauth_invite \gset

select is(
  (auth.link_identity_by_token(:'oauth_invite'::jsonb ->> 'token', 'google', 'https://accounts.google.com', 'google-sub-1', 'oauth_invitee@example.com', null, null) ->> 'user_id'),
  '55555555-5555-5555-5555-555555555555',
  'link_identity_by_token activates invited user and links identity');

select throws_ok(
  format('select auth.link_identity_by_token(%L, %L, %L, %L, %L, null, null)',
    :'oauth_invite'::jsonb ->> 'token', 'google', 'https://accounts.google.com', 'google-sub-2', 'oauth_invitee@example.com'),
  '42501', 'invalid_token', 'link_identity_by_token rejects consumed token');

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.identity.linked'
      and outcome = 'success'
      and subject_id in ('33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555')),
  2::bigint, 'auth.identity.linked event is recorded on link');

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.identity.unlinked'
      and outcome = 'success'
      and subject_id = '33333333-3333-3333-3333-333333333333'),
  1::bigint, 'auth.identity.unlinked event is recorded on unlink');

-- Card I-09: Password Reset, Logout, and Session Management
select auth.request_password_reset('external@example.com', '192.168.1.1'::inet);

select is(
  (select count(*) from iam.one_time_token
    where user_id = '33333333-3333-3333-3333-333333333333'
      and purpose = 'password_reset'
      and used_at is null
      and expires_at > now() + interval '29 minutes'),
  1::bigint, 'password reset generates 30-min token in iam.one_time_token');

select is(
  (select count(*) from core.outbox
    where kind = 'password_reset_email'
      and (payload ->> 'email') = 'external@example.com'
      and status = 'pending'),
  1::bigint, 'password reset enqueues password_reset_email in outbox');

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.password.reset_requested'
      and outcome = 'success'
      and subject_id = '33333333-3333-3333-3333-333333333333'),
  1::bigint, 'auth.password.reset_requested event recorded');

select auth.request_password_reset('nonexistent@example.com', '192.168.1.1'::inet);

select is(
  (select count(*) from core.outbox
    where kind = 'password_reset_email'
      and (payload ->> 'email') = 'nonexistent@example.com'),
  0::bigint, 'nonexistent email does not enqueue outbox email');

select payload ->> 'token' as reset_token
  from core.outbox
 where kind = 'password_reset_email'
   and (payload ->> 'email') = 'external@example.com'
 order by created_at desc limit 1 \gset

select is(
  (auth.set_password(:'reset_token', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhash$dummy') ->> 'user_id'),
  '33333333-3333-3333-3333-333333333333',
  'password reset succeeds with valid token');

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.password.reset_completed'
      and outcome = 'success'
      and subject_id = '33333333-3333-3333-3333-333333333333'),
  2::bigint, 'auth.password.reset_completed event recorded');

select throws_ok(
  format('select auth.set_password(%L, %L)',
    :'reset_token', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhash$dummy'),
  '42501', 'invalid_token', 'password reset token is single-use and cannot be replayed');

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_A') ->> 'session_id' as sid_a \gset
select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_B') ->> 'session_id' as sid_b \gset

select is(
  (select count(*) from auth.user_sessions(:'sid_a'::uuid)),
  2::bigint, 'user_sessions returns active sessions for caller user');

select auth.session_revoke(:'sid_a'::uuid, :'sid_b'::uuid);

select is(
  (select count(*) from iam.session
    where id = :'sid_b'::uuid and revoked_at is not null and revoke_reason = 'user_revoked'),
  1::bigint, 'session_revoke(actor, target) revokes target session');

select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.session.revoked'
      and outcome = 'success'
      and subject_id = '33333333-3333-3333-3333-333333333333'
      and (detail ->> 'session_id') = :'sid_b'),
  1::bigint, 'auth.session.revoked event recorded for revoked target session');

select throws_ok(
  format('select auth.session_revoke(%L::uuid, %L::uuid)', :'sid_a', :'actor_sid2'),
  '42501', 'target_session_not_found', 'session_revoke refuses revoking another user session');

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_C') ->> 'session_id' as sid_c \gset

select auth.session_revoke_all(:'sid_a'::uuid, true);

select is(
  (select count(*) from iam.session
    where user_id = '33333333-3333-3333-3333-333333333333' and revoked_at is null),
  1::bigint, 'session_revoke_all with keep_current keeps current session only');

-- API self-service session assertions
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '33333333-3333-3333-3333-333333333333',
  'sid', :'sid_a',
  'role', 'ext_user'
)::text, true);

select is(
  (select count(*) from api.my_sessions() where is_current),
  1::bigint, 'api.my_sessions reflects current session');

select throws_ok(
  format('select api.revoke_my_session(%L::uuid)', :'actor_sid2'),
  '42501', 'session_not_found_or_revoked', 'api.revoke_my_session refuses revoking another user session');

select lives_ok(
  format('select api.revoke_my_session(%L::uuid)', :'sid_a'),
  'api.revoke_my_session revokes current session');

-- Rotation vs Logout session_revoke assertions
select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_rot') ->> 'session_id' as sid_rot \gset
select count(*) as cnt from audit_trail.event where event_type = 'auth.logout' \gset logout_before_

select auth.session_revoke_reason(:'sid_rot'::uuid, 'rotated');

select is(
  (select revoke_reason from iam.session where id = :'sid_rot'::uuid),
  'rotated', 'session_revoke with rotated sets revoke_reason to rotated');

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.logout'),
  :'logout_before_cnt'::bigint, 'session_revoke with rotated does not emit auth.logout');

select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_logout') ->> 'session_id' as sid_logout \gset

select auth.session_revoke(:'sid_logout'::uuid);

select is(
  (select revoke_reason from iam.session where id = :'sid_logout'::uuid),
  'logout', 'session_revoke default sets revoke_reason to logout');

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.logout' and (detail ->> 'session_id') = :'sid_logout'),
  1::bigint, 'session_revoke default emits auth.logout event');

-- Token issue invalidates prior tokens for same purpose
select auth.token_issue('33333333-3333-3333-3333-333333333333', 'password_reset', :'actor_sid3'::uuid) as tok1 \gset
select auth.token_issue('33333333-3333-3333-3333-333333333333', 'password_reset', :'actor_sid3'::uuid) as tok2 \gset

select is(
  auth.token_consume('password_reset', :'tok1'::jsonb ->> 'token'),
  null, 'prior password reset token was invalidated by new token_issue');

select is(
  (auth.token_consume('password_reset', :'tok2'::jsonb ->> 'token') ->> 'user_id'),
  '33333333-3333-3333-3333-333333333333', 'latest password reset token consumes successfully');

-- API revoke_all_my_sessions tests
select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_api_1') ->> 'session_id' as sid_api_1 \gset
select auth.session_create('33333333-3333-3333-3333-333333333333', 'pwd', 'ext_user',
  '127.0.0.1', 'session_api_2') ->> 'session_id' as sid_api_2 \gset

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '33333333-3333-3333-3333-333333333333',
  'sid', :'sid_api_1',
  'role', 'ext_user'
)::text, true);

select api.revoke_all_my_sessions(true);

select is(
  (select count(*) from iam.session where user_id = '33333333-3333-3333-3333-333333333333' and revoked_at is null),
  1::bigint, 'api.revoke_all_my_sessions(true) keeps only current session');

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.session.revoked' and reason = 'revoke_others'),
  1::bigint, 'api.revoke_all_my_sessions(true) emits event with reason revoke_others');

select api.revoke_all_my_sessions(false);

select is(
  (select count(*) from iam.session where user_id = '33333333-3333-3333-3333-333333333333' and revoked_at is null),
  0::bigint, 'api.revoke_all_my_sessions(false) revokes all sessions including current');

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.session.revoked' and reason = 'logout_all' and outcome = 'success'),
  1::bigint, 'api.revoke_all_my_sessions(false) emits event with reason logout_all');

-- Card H-04: Entra deprovisioning sync worker pgTAP tests
select has_table('audit_trail', 'entra_sync_run', 'audit_trail.entra_sync_run table exists');

select throws_ok(
  $$set role int_viewer; select * from private.entra_sync_list_staff();$$,
  '42501', 'permission denied for function entra_sync_list_staff', 'unprivileged role cannot list staff for entra sync');
reset role;

-- ADR-0017 regression: a definer function used to compare `session_user`,
-- which reports the definer (mms_owner) and therefore accepted every caller that
-- held the EXECUTE grant. PostgREST connects as authenticator and switches to a
-- capability role with SET LOCAL ROLE, so the 'role' GUC names the capability
-- role and the owner never appears. private.caller_role() reads that GUC.
--
-- Kept at the top level of this transaction on purpose: a SET LOCAL ROLE undone
-- by ROLLBACK also discards the session search_path set at the top of this file,
-- and pgTAP's helpers live in `extensions`, so nested blocks would break every
-- later assertion in this suite.
set local role authenticator;
set local role int_sysadmin;
select is(private.caller_role(), 'int_sysadmin', 'caller_role reports the PostgREST capability role');
select is(private.is_worker(), false, 'a PostgREST capability role is never the worker');
set local role worker;
select is(private.caller_role(), 'worker', 'caller_role reports the worker login');
select is(private.is_worker(), true, 'the worker login is recognised as the worker');
reset role;

select throws_ok(
  $$set role int_viewer; select private.deprovision_staff_user('22222222-2222-2222-2222-222222222222', 'test');$$,
  '42501', 'permission denied for function deprovision_staff_user', 'unprivileged role cannot deprovision staff user');
reset role;

\i db/fixtures/org.sql

-- Setup staff user with position, role assignment, and active session
insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values ('fa000000-0000-0000-0000-000000000001', 'internal', 'Sync Test User',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'fa000000-0000-0000-0000-000000000002', 'active');

insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'fa000000-0000-0000-0000-000000000003', 'fa000000-0000-0000-0000-000000000001', 'internal',
       'senior_admins', 'office_admin', u.id, tstzrange(now() - interval '1 day', now() + interval '1 day'),
       '11111111-1111-1111-1111-111111111111', 'position grant'
  from core.org_unit u where u.code = 'SHA' limit 1;

insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'fa000000-0000-0000-0000-000000000006', 'fa000000-0000-0000-0000-000000000001', 'internal',
       'senior_admins', 'office_admin', u.id, tstzrange(now() + interval '1 day', null),
       '11111111-1111-1111-1111-111111111111', 'future position grant'
  from core.org_unit u where u.code = 'SHA' limit 1;

insert into iam.role_assignment (id, user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
values ('fa000000-0000-0000-0000-000000000004', 'fa000000-0000-0000-0000-000000000001', 'internal',
        'int_coordinator', 'global', 'manual', '11111111-1111-1111-1111-111111111111', 'assignment grant');

insert into iam.session (id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
values ('fa000000-0000-0000-0000-000000000005', 'fa000000-0000-0000-0000-000000000001', 'internal',
        'int_coordinator', 'entra', now() + interval '1 hour', now() + interval '8 hours');

-- Test listing
set role worker;
select isnt_empty(
  $$select * from private.entra_sync_list_staff() where user_id = 'fa000000-0000-0000-0000-000000000001'$$,
  'private.entra_sync_list_staff lists active staff user');

-- Test deprovisioning execution as worker
select is(
  (private.deprovision_staff_user(
    'fa000000-0000-0000-0000-000000000001',
    'Entra deprovisioning: MMS.User removed in directory'
  ) ->> 'deactivated')::boolean,
  true, 'private.deprovision_staff_user returns deactivated = true');

reset role;

-- Test status changed to deactivated
select is(
  (select status from iam.app_user where id = 'fa000000-0000-0000-0000-000000000001'),
  'deactivated', 'user status transitioned to deactivated');

-- Test active sessions revoked with reason user_deactivated
select is(
  (select revoke_reason from iam.session where id = 'fa000000-0000-0000-0000-000000000005'),
  'user_deactivated', 'active session was automatically revoked by trigger with user_deactivated');

-- Test role assignment revoked
select is(
  (select revoked_at is not null from iam.role_assignment where id = 'fa000000-0000-0000-0000-000000000004'),
  true, 'role assignment was revoked during deprovisioning');

-- Test staff position closed
select is(
  (select upper(valid) <= now() from iam.staff_position where id = 'fa000000-0000-0000-0000-000000000003'),
  true, 'staff position valid upper bound was closed to now');

-- Test future staff position invalidated
select is(
  (select isempty(valid) from iam.staff_position where id = 'fa000000-0000-0000-0000-000000000006'),
  true, 'future staff position was invalidated to empty range');

-- Test audit event emitted
select is(
  (select count(*) from audit_trail.event
    where event_type = 'auth.user.deactivated'
      and subject_id = 'fa000000-0000-0000-0000-000000000001'),
  1::bigint, 'auth.user.deactivated audit event was emitted');

set role worker;

-- Test idempotency on already deactivated user
select is(
  (private.deprovision_staff_user(
    'fa000000-0000-0000-0000-000000000001',
    'Entra deprovisioning: repeated sync'
  ) ->> 'deactivated')::boolean,
  false, 'subsequent deprovisioning is idempotent (deactivated = false)');

-- Test recording sync run in audit_trail.entra_sync_run
select is(
  (select private.record_entra_sync_run(
    'deprovisioned',
    1,
    1,
    array['fa000000-0000-0000-0000-000000000001'::uuid],
    null,
    '{"reason":"test"}'::jsonb
  ) is not null),
  true, 'private.record_entra_sync_run inserts record and returns id');

select is(
  (select status from audit_trail.entra_sync_run where id = (select max(id) from audit_trail.entra_sync_run)),
  'deprovisioned', 'entra_sync_run record persisted with status deprovisioned');

reset role;

-- Test append-only trigger prevents updates to entra_sync_run
select throws_ok(
  $$update audit_trail.entra_sync_run set status = 'clean'$$,
  'P0001', 'audit reconciliation records are append-only', 'audit_trail.entra_sync_run is strictly append-only');

-- Test deactivated status remains terminal on resolve_entra sign-in (F-H01)
select is(
  (auth.resolve_entra(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'fa000000-0000-0000-0000-000000000002',
    'sync.user@example.com',
    'Sync Test User',
    array['MMS.User']
  ) ->> 'status'),
  'deactivated', 'resolve_entra keeps deactivated user status terminal');




