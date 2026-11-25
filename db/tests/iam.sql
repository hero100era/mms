begin;
set search_path = extensions, public;
\i db/fixtures/org.sql

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status) values
  ('11111111-1111-1111-1111-111111111111', 'internal', 'Alice', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'internal', 'Bob',   'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'active'),
  ('55555555-5555-5555-5555-555555555555', 'internal', 'Eve',   'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000005', 'active'),
  ('66666666-6666-6666-6666-666666666666', 'internal', 'Frank', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000006', 'active'),
  ('77777777-7777-7777-7777-777777777777', 'internal', 'Grace', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000007', 'active'),
  ('88888888-8888-8888-8888-888888888888', 'internal', 'Henry', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000008', 'active');

insert into iam.app_user (id, kind, display_name, email, status) values
  ('33333333-3333-3333-3333-333333333333', 'external', 'Carol', 'carol@example.com', 'active');

insert into iam.app_user (id, kind, display_name, service_name, status) values
  ('44444444-4444-4444-4444-444444444444', 'service', 'Worker', 'worker-test', 'active');

insert into party.organization (id, name, org_type, status) values
  ('99999999-9999-9999-9999-999999999999', 'Example Shipping', 'company', 'active');

insert into iam.user_identity (id, user_id, provider, issuer, subject, email_at_link) values
  ('aaaaaaaa-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'microsoft',
   'https://login.microsoftonline.com/tenant/v2.0', 'subject-1', 'carol@example.com');

insert into iam.staff_position (id, user_id, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'aaaaaaaa-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
       'surveyors', 'survey', u.id, tstzrange(now() - interval '1 day', null),
       '22222222-2222-2222-2222-222222222222', 'test'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (id, user_id, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'aaaaaaaa-3333-3333-3333-333333333333', '88888888-8888-8888-8888-888888888888',
       'surveyors', 'survey', u.id, tstzrange(now() - interval '10 days', now() - interval '5 days'),
       '22222222-2222-2222-2222-222222222222', 'expired test'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (id, user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'aaaaaaaa-4444-4444-4444-444444444444', '77777777-7777-7777-7777-777777777777',
       'int_surveyor', 'unit', u.id, 'manual', '22222222-2222-2222-2222-222222222222', 'test'
  from core.org_unit u where u.code = 'SHA';

insert into iam.session (id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
values ('aaaaaaaa-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 'internal',
        'int_surveyor', 'entra', now() + interval '1 hour', now() + interval '8 hours');

insert into iam.org_membership (id, user_id, org_id, member_role, granted_by)
values ('aaaaaaaa-6666-6666-6666-666666666666', '33333333-3333-3333-3333-333333333333',
        '99999999-9999-9999-9999-999999999999', 'requester', '22222222-2222-2222-2222-222222222222');

select plan(51);

select has_table('iam', 'app_user', 'iam.app_user exists');
select has_table('iam', 'staff_position', 'iam.staff_position exists');
select has_table('iam', 'role_assignment', 'iam.role_assignment exists');
select has_table('iam', 'session', 'iam.session exists');
select has_table('iam', 'position_proposal', 'iam.position_proposal exists');

select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'iam' and c.relkind = 'r' and c.relrowsecurity), 21::bigint,
          'all 21 iam tables have RLS enabled');

select is((select count(*) from iam.db_role), 11::bigint, '11 capability roles seeded');
select is((select count(*) from iam.job_family), 9::bigint, '9 job families seeded');
select is((select count(*) from iam.job_grade), 9::bigint, '9 job grades seeded');
select is((select count(*) from iam.job_title), 33::bigint, '33 job titles seeded');
select is((select count(*) from iam.default_role_rule), 17::bigint, '17 default role rules seeded');
select is((select count(*) from iam.authority_rule), 18::bigint, '18 authority rules seeded');

select is((select grade from iam.job_title where code = 'principal_surveyors'), 4,
          'principal surveyor is grade 4');
select is((select scope_target from iam.default_role_rule
            where unit_type = 'station' and job_family = 'survey' and min_grade = 4
              and db_role = 'int_surveyor'), 'parent_unit',
          'station surveyor grade 4 gets parent-unit scope');
select is((select max_amount from iam.authority_rule
            where action_code = 'billing.credit_note.approve' and min_grade = 6), null::numeric,
          'finance director credit-note rule is unlimited');

select throws_ok(
  $$insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
    values ('33333333-3333-3333-3333-333333333333', 'external', 'int_viewer', 'pwd', now(), now())$$,
  '23514', null, 'external session must use ext_user');

select throws_ok(
  $$insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
    values ('11111111-1111-1111-1111-111111111111', 'internal', 'ext_user', 'entra', now(), now())$$,
  '23514', null, 'internal session cannot use ext_user');

select throws_ok(
  $$insert into iam.app_user (kind, display_name) values ('internal', 'No Entra')$$,
  '23514', null, 'internal user requires tenant and object ids');

select throws_ok(
  $$insert into iam.app_user (kind, display_name) values ('external', 'No Email')$$,
  '23514', null, 'external user requires an email');

select throws_ok(
  $$insert into iam.user_identity (user_id, user_kind, provider, issuer, subject)
    values ('44444444-4444-4444-4444-444444444444', 'external', 'microsoft', 'issuer', 'subject')$$,
  '23503', null, 'service user cannot have an identity');

select throws_ok(
  $$insert into iam.user_identity (user_id, user_kind, provider, issuer, subject)
    values ('33333333-3333-3333-3333-333333333333', 'external', 'microsoft',
            'https://login.microsoftonline.com/tenant/v2.0', 'subject-1')$$,
  '23505', null, 'an issuer/subject has at most one active link');

select throws_ok(
  $$insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
    values ('11111111-1111-1111-1111-111111111111', 'int_surveyor', 'global', 'manual',
            '11111111-1111-1111-1111-111111111111', 'self')$$,
  '23514', null, 'nobody grants themselves an assignment');

select throws_ok(
  $$insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, valid, set_by, reason)
    select '11111111-1111-1111-1111-111111111111', 'surveyors', 'survey', u.id,
           tstzrange(now(), null), '11111111-1111-1111-1111-111111111111', 'self'
      from core.org_unit u where u.code = 'SHA'$$,
  '23514', null, 'nobody sets their own position');

select throws_ok(
  $$insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
    select '77777777-7777-7777-7777-777777777777', 'int_surveyor', 'unit', u.id, 'manual',
           '22222222-2222-2222-2222-222222222222', 'overlap'
      from core.org_unit u where u.code = 'SHA'$$,
  '23P01', null, 'assignments do not overlap');

select lives_ok(
  $$insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
    values ('55555555-5555-5555-5555-555555555555', 'int_sysadmin', 'global', 'manual',
            '22222222-2222-2222-2222-222222222222', 'sysadmin')$$,
  'sysadmin assignment is allowed alone');

select throws_ok(
  $$insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
    values ('55555555-5555-5555-5555-555555555555', 'int_viewer', 'global', 'manual',
            '22222222-2222-2222-2222-222222222222', 'business')$$,
  '23514', 'int_sysadmin_cannot_combine_with_business_role',
  'int_sysadmin cannot combine with a business role');

update iam.app_user set status = 'suspended' where id = '66666666-6666-6666-6666-666666666666';
select is((select count(*) from iam.session
            where user_id = '66666666-6666-6666-6666-666666666666' and revoked_at is not null),
          1::bigint, 'suspending a user revokes their sessions');

set local role int_surveyor;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'int_surveyor')::text, true);
select is((select unit_ids from private.my_scope()), array[(select id from core.org_unit where code = 'SHA')]::uuid[],
          'active assignment is visible in scope');
reset role;

update iam.role_assignment set revoked_at = now()
 where user_id = '77777777-7777-7777-7777-777777777777';

set local role int_surveyor;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'int_surveyor')::text, true);
select is((select unit_ids from private.my_scope()), '{}'::uuid[],
          'revoked assignment removes scope');
reset role;

set local role ext_user;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'ext_user')::text, true);
select is((select my_org_ids from private.my_org_ids()),
          array['99999999-9999-9999-9999-999999999999']::uuid[],
          'active membership is visible');
reset role;

update iam.org_membership set revoked_at = now()
 where user_id = '33333333-3333-3333-3333-333333333333';

set local role ext_user;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'ext_user')::text, true);
select is((select my_org_ids from private.my_org_ids()), '{}'::uuid[],
          'revoked membership removes access');
reset role;

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '88888888-8888-8888-8888-888888888888', 'role', 'int_viewer')::text, true);
select is((select count(*) from private.my_position()), 0::bigint,
          'expired position is not current');
reset role;

select is((select count(*) from iam.db_role d
            where not exists (select 1 from pg_roles r where r.rolname = d.role_name)), 0::bigint,
          'every db_role exists in pg_roles');
select is((select count(*) from pg_roles r join iam.db_role d on d.role_name = r.rolname
            where r.rolcanlogin), 0::bigint, 'capability roles are NOLOGIN');
select is((select count(*) from pg_roles r
            where (left(r.rolname, 4) = 'int_' or r.rolname in ('web_anon', 'ext_user'))
              and not exists (select 1 from iam.db_role d where d.role_name = r.rolname)), 0::bigint,
          'no unlisted capability role exists');

select throws_ok($$insert into iam.job_grade (grade, label_en) values (9, 'Too high')$$,
                 '23514', null, 'job grade is between 0 and 8');
select throws_ok($$insert into iam.app_user (kind, display_name, email)
                   values ('external', 'Upper', 'UPPER@EXAMPLE.COM')$$,
                 '23514', null, 'email must be lowercase');
select throws_ok($$insert into iam.default_role_rule
                   (unit_type, job_family, min_grade, max_grade, db_role, scope_target)
                   values (null, null, 5, 4, 'int_viewer', 'own_unit')$$,
                 '23514', null, 'default role rule has min <= max');
select throws_ok($$insert into iam.authority_rule (action_code, db_role, min_grade)
                   values ('x', 'int_viewer', 0)$$,
                 '23514', null, 'authority rule requires grade >= 1');
select throws_ok($$insert into iam.authority_rule (action_code, db_role, min_grade, max_amount)
                   values ('x', 'int_viewer', 2, 10)$$,
                 '23514', null, 'amount and currency are set together');
select throws_ok($$insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
                   values ('11111111-1111-1111-1111-111111111111', 'internal', 'int_surveyor', 'x', now(), now())$$,
                 '23514', null, 'auth method is known');
select throws_ok($$insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
                   select '11111111-1111-1111-1111-111111111111', 'int_surveyor', 'global', u.id, 'manual',
                          '22222222-2222-2222-2222-222222222222', 'bad'
                     from core.org_unit u where u.code = 'SHA'$$,
                 '23514', null, 'global scope has no unit');
select throws_ok($$insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
                   values ('11111111-1111-1111-1111-111111111111', 'int_surveyor', 'global', 'position',
                           '22222222-2222-2222-2222-222222222222', 'bad')$$,
                 '23514', null, 'position source has a position id');
select throws_ok($$insert into iam.user_identity (user_id, provider, issuer, subject)
                   values ('33333333-3333-3333-3333-333333333333', 'x', 'issuer', 'subject')$$,
                 '23514', null, 'identity provider is known');
select throws_ok($$insert into iam.org_membership (user_id, org_id, member_role, granted_by)
                   values ('33333333-3333-3333-3333-333333333333', '99999999-9999-9999-9999-999999999999',
                           'x', '22222222-2222-2222-2222-222222222222')$$,
                 '23514', null, 'membership role is known');
select throws_ok($$insert into iam.one_time_token (user_id, purpose, token_hash, expires_at)
                   values ('33333333-3333-3333-3333-333333333333', 'x', decode('00', 'hex'), now())$$,
                 '23514', null, 'token purpose is known');
select throws_ok($$insert into core.outbox (kind, status) values ('x', 'x')$$,
                 '23514', null, 'outbox status is known');
select throws_ok($$insert into party.organization (name, org_type) values ('X', 'x')$$,
                 '23514', null, 'organisation type is known');
select throws_ok($$insert into iam.login_attempt (login_name, outcome) values ('UPPER', 'failed')$$,
                 '23514', null, 'login name is lowercase');
select throws_ok($$insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
                   select '11111111-1111-1111-1111-111111111111', 'surveyors', 'survey', u.id,
                          '11111111-1111-1111-1111-111111111111', tstzrange(now(), null),
                          '22222222-2222-2222-2222-222222222222', 'bad'
                     from core.org_unit u where u.code = 'SHA'$$,
                 '23514', null, 'line manager is not self');
select throws_ok($$insert into iam.app_user (kind, display_name, service_name, email)
                   values ('service', 'Svc', 'svc-2', 'svc@example.com')$$,
                 '23514', null, 'service users have no email');

select * from finish();
rollback;
