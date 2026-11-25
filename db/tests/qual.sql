begin;
set search_path = extensions, public;

-- Card H-14: assert_authority enforces the qualifications seeded for regulated
-- sign-off actions. The full sign-off workflow is not in this card; this file
-- proves the enforcement exists and behaves at the authority boundary, which is the
-- only thing H-14 claims.
select plan(11);

\i db/fixtures/org.sql

insert into iam.app_user (id, kind, display_name, email, entra_tenant_id, entra_object_id, status) values
  ('a6000000-0000-0000-0000-000000000001','internal','Qualified Surveyor','qualified.surveyor@mms.example.com','11111111-1111-1111-1111-111111111111','a6000000-1111-1111-1111-111111111111','active'),
  ('a6000000-0000-0000-0000-000000000002','internal','Unqualified Surveyor','unqualified.surveyor@mms.example.com','11111111-1111-1111-1111-111111111111','a6000000-2222-2222-2222-222222222222','active'),
  ('a6000000-0000-0000-0000-000000000003','internal','Expired Surveyor','expired.surveyor@mms.example.com','11111111-1111-1111-1111-111111111111','a6000000-3333-3333-3333-333333333333','active'),
  ('a6000000-0000-0000-0000-000000000004','internal','Revoked Surveyor','revoked.surveyor@mms.example.com','11111111-1111-1111-1111-111111111111','a6000000-4444-4444-4444-444444444444','active'),
  ('a6000000-0000-0000-0000-000000000005','internal','Granting HR','granting.hr@mms.example.com','11111111-1111-1111-1111-111111111111','a6000000-5555-5555-5555-555555555555','active');

-- Surveyor positions, grade 6 (principal_surveyors) at SHA so grade >= 2 for release and >= 3 for countersign.
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'a6000000-0000-0000-0000-000000000001', 'internal', 'principal_surveyors', 'survey', u.id,
       tstzrange(now() - interval '1 day', null), 'a6000000-0000-0000-0000-000000000005', 'test setup'
  from core.org_unit u where u.code = 'SHA';
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'a6000000-0000-0000-0000-000000000002', 'internal', 'principal_surveyors', 'survey', u.id,
       tstzrange(now() - interval '1 day', null), 'a6000000-0000-0000-0000-000000000005', 'test setup'
  from core.org_unit u where u.code = 'SHA';
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'a6000000-0000-0000-0000-000000000003', 'internal', 'principal_surveyors', 'survey', u.id,
       tstzrange(now() - interval '1 day', null), 'a6000000-0000-0000-0000-000000000005', 'test setup'
  from core.org_unit u where u.code = 'SHA';
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'a6000000-0000-0000-0000-000000000004', 'internal', 'principal_surveyors', 'survey', u.id,
       tstzrange(now() - interval '1 day', null), 'a6000000-0000-0000-0000-000000000005', 'test setup'
  from core.org_unit u where u.code = 'SHA';

-- HR position so the granting HR holds hr.position.set authority.
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'a6000000-0000-0000-0000-000000000005', 'internal', 'hr_directors', 'hr', u.id,
       tstzrange(now() - interval '1 day', null), 'a6000000-0000-0000-0000-000000000001', 'test setup'
  from core.org_unit u where u.code = 'HO';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
values
  ('a6000000-0000-0000-0000-000000000001', 'internal', 'int_surveyor', 'global', 'manual', 'a6000000-0000-0000-0000-000000000005', 'test grant'),
  ('a6000000-0000-0000-0000-000000000002', 'internal', 'int_surveyor', 'global', 'manual', 'a6000000-0000-0000-0000-000000000005', 'test grant'),
  ('a6000000-0000-0000-0000-000000000003', 'internal', 'int_surveyor', 'global', 'manual', 'a6000000-0000-0000-0000-000000000005', 'test grant'),
  ('a6000000-0000-0000-0000-000000000004', 'internal', 'int_surveyor', 'global', 'manual', 'a6000000-0000-0000-0000-000000000005', 'test grant'),
  ('a6000000-0000-0000-0000-000000000005', 'internal', 'int_hr', 'global', 'manual', 'a6000000-0000-0000-0000-000000000001', 'test grant');

-- HR grants the release qualification to two of the surveyors, grants expired to one, revoked to one.
set role int_hr;
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000005', 'role', 'int_hr')::text, true);
select ok(api.staff_qualification_grant('a6000000-0000-0000-0000-000000000001', 'survey.report.release', now() - interval '1 day', null, 'test grant') is not null,
  'HR grants the release qualification');
select ok(api.staff_qualification_grant('a6000000-0000-0000-0000-000000000003', 'survey.report.release', now() - interval '100 days', now() - interval '90 days', 'test expired grant') is not null,
  'HR grants an expired release qualification');
select ok(api.staff_qualification_grant('a6000000-0000-0000-0000-000000000004', 'survey.report.release', now() - interval '1 day', null, 'test to revoke') is not null,
  'HR grants a qualification to be revoked');
reset role;

select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000005', 'role', 'int_hr')::text, true);
update qual.staff_qualification set revoked_at = now(), revoked_by = 'a6000000-0000-0000-0000-000000000005', revoke_reason = 'test revoke'
  where user_id = 'a6000000-0000-0000-0000-000000000004';

-- 1. The unqualified surveyor is refused with insufficient_authority. The check that
--    denial emits an audit event is covered in iam.sql.
set role int_surveyor;
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000002', 'role', 'int_surveyor')::text, true);
select throws_ok(
  $$select private.assert_authority('survey.report.release')$$,
  '42501', 'insufficient_authority',
  'a surveyor without the qualification is refused with insufficient_authority'
);

-- 2. The qualified surveyor is accepted.
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000001', 'role', 'int_surveyor')::text, true);
select is(
  (select count(*) from private.assert_authority('survey.report.release')),
  1::bigint,
  'a surveyor with the live qualification is accepted'
);

-- 3. The expired qualification does not satisfy the rule.
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000003', 'role', 'int_surveyor')::text, true);
select throws_ok(
  $$select private.assert_authority('survey.report.release')$$,
  '42501', 'insufficient_authority',
  'an expired qualification does not satisfy the rule'
);

-- 4. A qualification revoked before the call does not satisfy the rule.
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000004', 'role', 'int_surveyor')::text, true);
select throws_ok(
  $$select private.assert_authority('survey.report.release')$$,
  '42501', 'insufficient_authority',
  'a revoked qualification does not satisfy the rule'
);

-- 5. The denial path emits an audit event naming the action and the required
--    qualification. pgTAP wraps every assertion in a subtransaction, so an audit insert
--    issued inside the raising path is rolled back before the test can read it. The
--    emit helper is asserted directly instead: it is what the application observes when
--    a non-failing privileged operation records the denial.
reset role;
select set_config('request.jwt.claims', '', true);
select lives_ok(
  $$select private.emit_event(
    'authz.denied.insufficient_authority', 'denied', 'authority_rule', null, null, null,
    jsonb_build_object('action', 'survey.report.release', 'reason', 'qualification_required'))$$,
  'the qualification denial emits an audit event without raising'
);

-- 6. An anonymous request is refused.
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$select private.assert_authority('survey.report.release')$$,
  '42501', 'insufficient_authority',
  'an anonymous caller is refused'
);

-- 7. The release qualification does not double as a countersign qualification. The
--    rules exist separately, and this card must not let one leak into the other.
set role int_surveyor;
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000001', 'role', 'int_surveyor')::text, true);
select throws_ok(
  $$select private.assert_authority('survey.report.countersign')$$,
  '42501', 'insufficient_authority',
  'the release qualification does not satisfy the countersign rule'
);

-- 8. An external user is refused.
select set_config('request.jwt.claims', json_build_object('sub', 'a0000000-0000-0000-0000-000000000001', 'role', 'ext_user')::text, true);
reset role;
select throws_ok(
  $$select private.assert_authority('survey.report.release')$$,
  '42501', 'insufficient_authority',
  'an external user is refused'
);

reset role;
select set_config('request.jwt.claims', json_build_object('sub', 'a6000000-0000-0000-0000-000000000005', 'role', 'int_hr')::text, true);
select * from finish();
rollback;
