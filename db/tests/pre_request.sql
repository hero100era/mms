begin;
set search_path = extensions, public;

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values
  ('11111111-1111-1111-1111-111111111111', 'internal', 'Actor',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'internal', 'Other',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'active');

insert into iam.app_user (id, kind, display_name, email, status)
values ('33333333-3333-3333-3333-333333333333', 'external', 'External', 'external@example.com', 'active');

insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
values ('11111111-1111-1111-1111-111111111111', 'int_viewer', 'global', 'manual',
        '22222222-2222-2222-2222-222222222222', 'test');

insert into iam.session (id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
values
  ('aaaaaaaa-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'internal',
   'int_viewer', 'entra', now() + interval '1 hour', now() + interval '8 hours'),
  ('aaaaaaaa-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'external',
   'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours');

select plan(13);

select lives_ok($$select set_config('request.jwt.claims', '{"role":"web_anon"}', true);
  select private.pre_request()$$, 'anonymous request passes');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"web_anon","sub":"11111111-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT401', 'anon_with_subject', 'anonymous token with sub is rejected');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"mms_owner","sub":"11111111-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT403', 'role_not_allowed', 'login roles are rejected');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_unknown","sub":"11111111-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT403', 'role_not_allowed', 'unknown roles are rejected');

select lives_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"11111111-1111-1111-1111-111111111111","sid":"aaaaaaaa-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'valid internal session passes');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"33333333-3333-3333-3333-333333333333","sid":"aaaaaaaa-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT401', 'session_invalid', 'sub must match the session user');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"11111111-1111-1111-1111-111111111111","sid":"aaaaaaaa-9999-9999-9999-999999999999"}', true);
  select private.pre_request()$$, 'PT401', 'session_invalid', 'revoked or unknown sid is rejected');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"11111111-1111-1111-1111-111111111111","sid":"aaaaaaaa-1111-1111-1111-111111111111"}', true);
  update iam.session set idle_expires_at = now() - interval '1 second'
   where id = 'aaaaaaaa-1111-1111-1111-111111111111';
  select private.pre_request()$$, 'PT401', 'session_invalid', 'idle-expired session is rejected');

update iam.session set idle_expires_at = now() + interval '1 hour',
       expires_at = now() - interval '1 second'
 where id = 'aaaaaaaa-1111-1111-1111-111111111111';
select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"11111111-1111-1111-1111-111111111111","sid":"aaaaaaaa-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT401', 'session_invalid', 'absolute-expired session is rejected');

update iam.session set expires_at = now() + interval '8 hours',
       active_role = 'int_surveyor'
 where id = 'aaaaaaaa-1111-1111-1111-111111111111';
select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"11111111-1111-1111-1111-111111111111","sid":"aaaaaaaa-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT401', 'session_invalid', 'role must equal the session active role');

update iam.session set active_role = 'int_viewer'
 where id = 'aaaaaaaa-1111-1111-1111-111111111111';
update iam.role_assignment set revoked_at = now()
 where user_id = '11111111-1111-1111-1111-111111111111' and db_role = 'int_viewer';
select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"11111111-1111-1111-1111-111111111111","sid":"aaaaaaaa-1111-1111-1111-111111111111"}', true);
  select private.pre_request()$$, 'PT401', 'session_invalid', 'revoked assignment is rejected');

select throws_ok($$select set_config('request.jwt.claims',
    '{"role":"int_viewer","sub":"33333333-3333-3333-3333-333333333333","sid":"aaaaaaaa-3333-3333-3333-333333333333"}', true);
  select private.pre_request()$$, 'PT401', 'session_invalid', 'external user cannot use an internal role');

select lives_ok($$select set_config('request.jwt.claims',
    '{"role":"ext_user","sub":"33333333-3333-3333-3333-333333333333","sid":"aaaaaaaa-3333-3333-3333-333333333333"}', true);
  select private.pre_request()$$, 'valid external session passes');
