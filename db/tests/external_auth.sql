begin;
set search_path = extensions, public;

select plan(30);
\i db/fixtures/org.sql

-- Users
insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values
  ('e0000000-0000-0000-0000-000000000001', 'internal', 'HR Admin',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e0000000-0000-0000-0000-000000000001', 'active'),
  ('e0000000-0000-0000-0000-000000000002', 'internal', 'Coordinator G1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e0000000-0000-0000-0000-000000000002', 'active'),
  ('e0000000-0000-0000-0000-000000000003', 'internal', 'Coordinator G2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e0000000-0000-0000-0000-000000000003', 'active'),
  ('e0000000-0000-0000-0000-000000000004', 'internal', 'Viewer Only',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e0000000-0000-0000-0000-000000000004', 'active'),
  ('e0000000-0000-0000-0000-000000000005', 'internal', 'Sysadmin IT',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e0000000-0000-0000-0000-000000000005', 'active')
on conflict (id) do nothing;

-- Setup positions for staff
insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, valid, set_by, reason)
values
  ('e0000000-0000-0000-0000-000000000001', 'hr_directors', 'hr', (select id from core.org_unit where code = 'HO'), tstzrange(now() - interval '1 hour', null), 'e0000000-0000-0000-0000-000000000005', 'init'),
  ('e0000000-0000-0000-0000-000000000002', 'junior_engineers', 'office_admin', (select id from core.org_unit where code = 'SHA'), tstzrange(now() - interval '1 hour', null), 'e0000000-0000-0000-0000-000000000001', 'init'),
  ('e0000000-0000-0000-0000-000000000003', 'admins', 'office_admin', (select id from core.org_unit where code = 'SHA'), tstzrange(now() - interval '1 hour', null), 'e0000000-0000-0000-0000-000000000001', 'init'),
  ('e0000000-0000-0000-0000-000000000004', 'interns', 'office_admin', (select id from core.org_unit where code = 'SHA'), tstzrange(now() - interval '1 hour', null), 'e0000000-0000-0000-0000-000000000001', 'init')
on conflict do nothing;

-- Role assignments
insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
values
  ('e0000000-0000-0000-0000-000000000001', 'internal', 'int_hr', 'global', 'manual', 'e0000000-0000-0000-0000-000000000005', 'hr setup'),
  ('e0000000-0000-0000-0000-000000000002', 'internal', 'int_coordinator', 'global', 'manual', 'e0000000-0000-0000-0000-000000000001', 'coord setup'),
  ('e0000000-0000-0000-0000-000000000003', 'internal', 'int_coordinator', 'global', 'manual', 'e0000000-0000-0000-0000-000000000001', 'coord setup'),
  ('e0000000-0000-0000-0000-000000000004', 'internal', 'int_viewer', 'global', 'manual', 'e0000000-0000-0000-0000-000000000001', 'viewer setup'),
  ('e0000000-0000-0000-0000-000000000005', 'internal', 'int_sysadmin', 'global', 'manual', 'e0000000-0000-0000-0000-000000000001', 'sysadmin setup')
on conflict do nothing;

-- 1. int_viewer cannot create external user
select set_config('request.jwt.claims', json_build_object('sub','e0000000-0000-0000-0000-000000000004','role','int_viewer')::text, true);
select throws_ok(
  $$select api.create_external_user('ext1@example.com', 'Ext One', 'test invite')$$,
  '42501', 'insufficient_authority', 'int_viewer cannot create external user'
);

-- 2. Grade 1 coordinator cannot create external user
select set_config('request.jwt.claims', json_build_object('sub','e0000000-0000-0000-0000-000000000002','role','int_coordinator')::text, true);
select throws_ok(
  $$select api.create_external_user('ext1@example.com', 'Ext One', 'test invite')$$,
  '42501', 'insufficient_authority', 'grade-1 coordinator cannot create external user'
);

-- 3. Grade 2 coordinator can create external user
select set_config('request.jwt.claims', json_build_object('sub','e0000000-0000-0000-0000-000000000003','role','int_coordinator')::text, true);
select lives_ok(
  $$select api.create_external_user('ext1@example.com', 'Ext One', 'client onboard')$$,
  'grade-2 coordinator can create external user'
);

-- 4. Check user state and outbox enqueued
select is(
  (select status from iam.app_user where email = 'ext1@example.com'),
  'invited', 'new external user is in invited status'
);

select is(
  (select count(*) from core.outbox where kind = 'invite_email' and payload ->> 'email' = 'ext1@example.com'),
  1::bigint, 'invite email was enqueued in core.outbox'
);

select is(
  (select enqueued_by from core.outbox where kind = 'invite_email' and payload ->> 'email' = 'ext1@example.com'),
  'e0000000-0000-0000-0000-000000000003'::uuid,
  'outbox job enqueued_by is the inviting coordinator'
);

-- 5. Sysadmin can create external user
select set_config('request.jwt.claims', json_build_object('sub','e0000000-0000-0000-0000-000000000005','role','int_sysadmin')::text, true);
select lives_ok(
  $$select api.create_external_user('ext2@example.com', 'Ext Two', 'sysadmin invite')$$,
  'sysadmin can create external user'
);

-- 5b. Duplicate email cannot be created
select throws_ok(
  $$select api.create_external_user('ext1@example.com', 'Duplicate One', 'dup test')$$,
  '23505', 'email_already_registered', 'cannot create user with already registered email'
);

-- 6. Re-invite external user
select set_config('request.jwt.claims', json_build_object('sub','e0000000-0000-0000-0000-000000000003','role','int_coordinator')::text, true);
select lives_ok(
  $$select api.invite_external_user((select id from iam.app_user where email = 'ext1@example.com'), 'reinvite')$$,
  'grade-2 coordinator can re-invite external user'
);

-- 6b. Re-inviting invalidates previous unconsumed invite tokens
select is(
  (select count(*) from iam.one_time_token where user_id = (select id from iam.app_user where email = 'ext1@example.com') and expires_at > now() and used_at is null),
  1::bigint,
  're-inviting expires prior unconsumed invite tokens'
);

-- 6c. Expired prior invite token cannot be used
select throws_ok(
  format($$select auth.set_password('%s', '$argon2id$v=19$m=19456,t=2,p=1$mocknonce$mockhashvalue1234567890')$$, (select payload ->> 'token' from core.outbox where payload ->> 'email' = 'ext1@example.com' order by created_at asc limit 1)),
  '42501', 'invalid_token', 'expired prior invite token cannot be used'
);

-- 7. Worker role polls outbox
set session authorization worker;
select is(
  (select count(*) from private.job_poll(10) where kind = 'invite_email'),
  3::bigint, 'worker job_poll returns pending jobs'
);

-- 8. Non-worker cannot call job_begin
reset session authorization;
select throws_ok(
  $$select private.job_begin((select id from core.outbox where kind = 'invite_email' limit 1))$$,
  '42501', 'worker_role_required', 'non-worker cannot call job_begin'
);

-- 9. Worker executes job_begin and job_complete
set session authorization worker;
create temp table _worker_test_job as
select private.job_begin((select id from private.job_poll(10) where kind = 'invite_email' and payload ->> 'email' = 'ext1@example.com' limit 1)) as job;

select ok((select (job->>'id') is not null from _worker_test_job), 'worker can begin job');

-- Check outbox status and change_log attribution
reset session authorization;
select is(
  (select status from core.outbox where id = (select (job->>'id')::uuid from _worker_test_job)),
  'processing', 'job is in processing status'
);

select is(
  (select actor_id from audit_trail.change_log where table_name = 'outbox' and op = 'U' order by occurred_at desc limit 1),
  (select id from iam.app_user where service_name = 'worker'),
  'outbox job update is recorded with actor_id = worker'
);

select is(
  (select initiated_by from audit_trail.change_log where table_name = 'outbox' and op = 'U' order by occurred_at desc limit 1),
  'e0000000-0000-0000-0000-000000000003'::uuid,
  'outbox job update is recorded with initiated_by = inviting coordinator'
);

set session authorization worker;
select lives_ok(
  $$select private.job_complete((select (job->>'id')::uuid from _worker_test_job), 'done')$$,
  'worker can complete job'
);

-- 9b. Cannot begin a job that is already completed (not pending)
select throws_ok(
  $$select private.job_begin((select (job->>'id')::uuid from _worker_test_job))$$,
  '55P03', 'job_not_pending', 'cannot begin a job that is not pending'
);

-- 9c. Cannot complete a job that is not in processing state
select throws_ok(
  $$select private.job_complete((select (job->>'id')::uuid from _worker_test_job), 'done')$$,
  'job_not_processing', 'cannot complete a job that is not in processing state'
);

-- 9d. Worker attribution preserved on failure
create temp table _worker_fail_job as
select private.job_begin((select id from private.job_poll(10) where kind = 'invite_email' and payload ->> 'email' = 'ext2@example.com' limit 1)) as job;

select lives_ok(
  $$select private.job_complete((select (job->>'id')::uuid from _worker_fail_job), 'failed', 'delivery error')$$,
  'worker can complete job as failed'
);
reset session authorization;

select is(
  (select actor_id from audit_trail.change_log where table_name = 'outbox' and new_row ->> 'status' = 'failed' order by occurred_at desc limit 1),
  (select id from iam.app_user where service_name = 'worker'),
  'failed job completion records actor_id = worker'
);

-- 10. Accept invite and set password using token
do $$
declare
  v_token text;
  v_user_id uuid;
  v_res jsonb;
begin
  select payload ->> 'token', (payload ->> 'user_id')::uuid
    into v_token, v_user_id
    from core.outbox
   where payload ->> 'email' = 'ext1@example.com'
   order by created_at desc
   limit 1;

  v_res := auth.set_password(v_token, '$argon2id$v=19$m=19456,t=2,p=1$mocknonce$mockhashvalue1234567890');
end;
$$;

select is(
  (select status from iam.app_user where email = 'ext1@example.com'),
  'active', 'setting password activates invited external user'
);

select ok(
  (select email_verified_at is not null from iam.app_user where email = 'ext1@example.com'),
  'setting password sets email_verified_at for invited user'
);

select is(
  (select count(*) from iam.password_credential where user_id = (select id from iam.app_user where email = 'ext1@example.com')),
  1::bigint, 'password credential was stored'
);

select is(
  (select count(*) from audit_trail.change_log where table_name = 'password_credential' and new_row ? 'hash'),
  0::bigint, 'password hash is never stored in audit_trail.change_log'
);

-- 10b. Active external user cannot be re-invited
select set_config('request.jwt.claims', json_build_object('sub','e0000000-0000-0000-0000-000000000003','role','int_coordinator')::text, true);
select throws_ok(
  $$select api.invite_external_user((select id from iam.app_user where email = 'ext1@example.com'), 'reinvite')$$,
  '42501', 'user_already_active_or_not_invited', 'cannot re-invite an already active external user'
);

-- 10c. Deactivated user cannot set password
update iam.app_user set status = 'deactivated' where email = 'ext2@example.com';
select throws_ok(
  $$select auth.set_password(
      (select payload ->> 'token' from core.outbox where payload ->> 'email' = 'ext2@example.com' limit 1),
      '$argon2id$v=19$m=19456,t=2,p=1$mocknonce$mockhashvalue1234567890'
    )$$,
  '42501', 'user_inactive', 'deactivated external user cannot set password'
);

-- 11. Lockout event on 5 failed attempts
do $$
begin
  perform auth.record_attempt('ext1@example.com', '192.0.2.1'::inet, 'failure', 'wrong_pass');
  perform auth.record_attempt('ext1@example.com', '192.0.2.1'::inet, 'failure', 'wrong_pass');
  perform auth.record_attempt('ext1@example.com', '192.0.2.1'::inet, 'failure', 'wrong_pass');
  perform auth.record_attempt('ext1@example.com', '192.0.2.1'::inet, 'failure', 'wrong_pass');
  perform auth.record_attempt('ext1@example.com', '192.0.2.1'::inet, 'failure', 'wrong_pass');
end;
$$;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.lockout' and detail ->> 'login_name' = 'ext1@example.com'),
  1::bigint, 'lockout event emitted on 5th failed attempt'
);

select is(
  auth.is_throttled('ext1@example.com', '192.0.2.1'::inet),
  true, 'user is throttled after 5 failures'
);

select * from finish();
rollback;
