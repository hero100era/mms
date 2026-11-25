begin;
set search_path = extensions, public;
select plan(41);
\i db/fixtures/org.sql

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status) values
  ('a0000000-0000-0000-0000-000000000001','internal','HR','11111111-1111-1111-1111-111111111111','a0000000-1111-1111-1111-111111111111','active'),
  ('a0000000-0000-0000-0000-000000000002','internal','Senior','11111111-1111-1111-1111-111111111111','a0000000-2222-2222-2222-222222222222','active'),
  ('a0000000-0000-0000-0000-000000000003','internal','Principal','11111111-1111-1111-1111-111111111111','a0000000-3333-3333-3333-333333333333','active'),
  ('a0000000-0000-0000-0000-000000000004','internal','Manager','11111111-1111-1111-1111-111111111111','a0000000-4444-4444-4444-444444444444','active'),
  ('a0000000-0000-0000-0000-000000000005','internal','Area Manager','11111111-1111-1111-1111-111111111111','a0000000-5555-5555-5555-555555555555','active'),
  ('a0000000-0000-0000-0000-000000000006','internal','Engineer','11111111-1111-1111-1111-111111111111','a0000000-6666-6666-6666-666666666666','active'),
  ('a0000000-0000-0000-0000-000000000007','internal','Compliance','11111111-1111-1111-1111-111111111111','a0000000-7777-7777-7777-777777777777','active'),
  ('a0000000-0000-0000-0000-000000000008','internal','Junior','11111111-1111-1111-1111-111111111111','a0000000-8888-8888-8888-888888888888','active'),
  ('a0000000-0000-0000-0000-000000000009','internal','Finance 4','11111111-1111-1111-1111-111111111111','a0000000-9999-9999-9999-999999999999','active'),
  ('a0000000-0000-0000-0000-00000000000a','internal','Finance 6','11111111-1111-1111-1111-111111111111','a0000000-aaaa-aaaa-aaaa-aaaaaaaaaaaa','active'),
  ('a0000000-0000-0000-0000-00000000000b','internal','Sysadmin','11111111-1111-1111-1111-111111111111','a0000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb','active'),
  ('a0000000-0000-0000-0000-00000000000c','internal','Intern','11111111-1111-1111-1111-111111111111','a0000000-cccc-cccc-cccc-cccccccccccc','active');

-- Bootstrap the HR position directly: it is the authority that sets every other
-- position. set_by must differ from the user; use the senior user.
insert into iam.staff_position (user_id,user_kind,job_title_code,job_family,unit_id,valid,set_by,reason)
select 'a0000000-0000-0000-0000-000000000001','internal','hr_directors','hr',u.id,
       tstzrange(now()-interval '1 day',null),'a0000000-0000-0000-0000-000000000002','bootstrap'
  from core.org_unit u where u.code='HO';
insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,source,granted_by,grant_reason)
values ('a0000000-0000-0000-0000-000000000001','internal','int_hr','global','manual',
        'a0000000-0000-0000-0000-000000000002','bootstrap');
insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,source,granted_by,grant_reason)
values ('a0000000-0000-0000-0000-00000000000b','internal','int_sysadmin','global','manual',
        'a0000000-0000-0000-0000-000000000001','bootstrap');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select api.staff_position_set('a0000000-0000-0000-0000-000000000002','senior_surveyors',(select id from core.org_unit where code='SHA'),null,'a0000000-0000-0000-0000-000000000004',now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000003','principal_surveyors',(select id from core.org_unit where code='SHA'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000004','managers',(select id from core.org_unit where code='SHA'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000005','managers',(select id from core.org_unit where code='CN-EAST-RO'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000006','engineers',(select id from core.org_unit where code='MTS-EAST'),'mts',null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000007','senior_compliance_officers',(select id from core.org_unit where code='HO-COMP'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000008','junior_surveyors',(select id from core.org_unit where code='SHA'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-000000000009','finance_managers',(select id from core.org_unit where code='HO'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-00000000000a','finance_directors',(select id from core.org_unit where code='HO'),null,null,now(),'test');
select api.staff_position_set('a0000000-0000-0000-0000-00000000000c','interns',(select id from core.org_unit where code='SHA'),'survey',null,now(),'test');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-00000000000b','role','int_sysadmin')::text, true);
select api.role_assignment_grant('a0000000-0000-0000-0000-000000000002','int_surveyor','unit',(select id from core.org_unit where code='NGB'),'manual survives move');

select is((select count(*) from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000002' and revoked_at is null), 3::bigint, 'senior has surveyor, viewer and manual assignment');
select is((select count(*) from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000002' and db_role='int_surveyor' and revoked_at is null and scope_unit_id=(select id from core.org_unit where code='SHA')), 1::bigint, 'senior surveyor is station scoped');
select is((select scope_unit_id from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000003' and db_role='int_surveyor' and revoked_at is null), (select id from core.org_unit where code='CN-EAST-RO'), 'principal surveyor is parent scoped');
select is((select scope_unit_id from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000004' and db_role='int_manager' and revoked_at is null), (select id from core.org_unit where code='SHA'), 'manager is station scoped');
select is((select count(*) from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000006' and revoked_at is null), 1::bigint, 'engineer has only viewer');
select is((select db_role from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000006' and revoked_at is null), 'int_viewer', 'engineer has no int_mts');
select is((select scope_type from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000007' and db_role='int_compliance' and revoked_at is null), 'global', 'HO compliance is global');
select is((select scope_unit_id from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000007' and db_role='int_compliance' and revoked_at is null), null, 'HO compliance has no unit scope');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000005','role','int_manager')::text, true);
select is((select count(*) from unnest(private.my_offices())), 3::bigint, 'area manager sees all China stations');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000004','role','int_manager')::text, true);
select lives_ok($$select private.assert_in_scope((select id from core.org_unit where code='SHA'))$$, 'station manager can act in Shanghai');
select throws_ok($$select private.assert_in_scope((select id from core.org_unit where code='NGB'))$$, '42501', 'out_of_scope', 'station manager cannot act in Ningbo');
select is((select count(*) from api.my_scope_units()), 1::bigint, 'station manager has one scope unit');
select is((select count(*) from api.my_reports()), 1::bigint, 'manager sees direct report');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select api.staff_position_set('a0000000-0000-0000-0000-000000000002','senior_surveyors',(select id from core.org_unit where code='NGB'),null,'a0000000-0000-0000-0000-000000000004',now(),'move');
select is((select count(*) from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000002' and db_role='int_surveyor' and revoked_at is null), 1::bigint, 'move leaves one surveyor assignment');
select is((select source from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000002' and db_role='int_surveyor' and revoked_at is null), 'manual', 'move keeps manual assignment');
select is((select scope_unit_id from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000002' and db_role='int_surveyor' and revoked_at is null), (select id from core.org_unit where code='NGB'), 'manual assignment preserved at unit across move');
select is((select scope_unit_id from iam.role_assignment where user_id='a0000000-0000-0000-0000-000000000002' and db_role='int_viewer' and revoked_at is null), (select id from core.org_unit where code='NGB'), 'move grants viewer at new unit');

select lives_ok($$select api.staff_position_set('a0000000-0000-0000-0000-000000000006','engineers',(select id from core.org_unit where code='MTS-EAST'),'mts',null,null,'null valid_from')$$, 'setting position with null valid_from defaults to now');
select throws_ok($$select api.staff_position_set('a0000000-0000-0000-0000-000000000002','senior_surveyors',(select id from core.org_unit where code='SHA'),null,null,now()-interval '10 days','preceding move')$$, '22023', 'valid_from_precedes_current_position', 'cannot move position to timestamp preceding current position');

select lives_ok($$select api.staff_position_set('a0000000-0000-0000-0000-000000000003','principal_surveyors',(select id from core.org_unit where code='NGB'),null,null,now()+interval '10 days','future move')$$, 'future position can be scheduled');
select lives_ok($$select api.staff_position_set('a0000000-0000-0000-0000-000000000003','senior_surveyors',(select id from core.org_unit where code='NGB'),null,null,now()+interval '10 days','future move update')$$, 'future position can be updated without collision');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-00000000000b','role','int_sysadmin')::text, true);
insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,scope_unit_id,source,valid,granted_by,grant_reason)
values ('a0000000-0000-0000-0000-000000000004','internal','int_manager','unit',(select id from core.org_unit where code='NGB'),'manual',
        tstzrange(now()+interval '10 days', null),'a0000000-0000-0000-0000-000000000001','future manual manager');
select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select lives_ok($$select api.staff_position_set('a0000000-0000-0000-0000-000000000004','managers',(select id from core.org_unit where code='NGB'),null,null,now()+interval '10 days','future manager position')$$, 'future position with overlapping manual assignment avoids duplicate insert');

select throws_ok($$select api.staff_position_set('a0000000-0000-0000-0000-000000000001','hr_directors',(select id from core.org_unit where code='HO'),null,null,now(),'self')$$, '42501', 'cannot_set_own_position', 'HR cannot set own position');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-00000000000b','role','int_sysadmin')::text, true);
select throws_ok($$select api.role_assignment_grant('a0000000-0000-0000-0000-00000000000b','int_viewer','global',null,'self')$$, '42501', 'cannot_grant_self', 'sysadmin cannot self grant');
select throws_ok($$insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,source,granted_by,grant_reason) values ('a0000000-0000-0000-0000-00000000000b','internal','int_viewer','global','manual','a0000000-0000-0000-0000-000000000001','bad')$$, '23514', null, 'sysadmin cannot hold business role');
select throws_ok($$select api.role_assignment_grant('a0000000-0000-0000-0000-00000000000c','int_surveyor','unit',(select id from core.org_unit where code='SHA'),'intern')$$, '42501', 'role_not_eligible', 'intern cannot receive manual surveyor');

-- Intern with manual surveyor role fails assert_authority
insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,scope_unit_id,source,granted_by,grant_reason)
values ('a0000000-0000-0000-0000-00000000000c','internal','int_surveyor','unit',(select id from core.org_unit where code='SHA'),'manual','a0000000-0000-0000-0000-000000000001','test intern manual');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-00000000000c','role','int_surveyor')::text, true);
set local role int_surveyor;
select throws_ok($$select private.assert_authority('survey.report.release',null)$$, '42501', 'insufficient_authority', 'intern with manual surveyor fails assert_authority');
reset role;

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000008','role','int_surveyor')::text, true);
set local role int_surveyor;
select throws_ok($$select private.assert_authority('survey.report.release',null)$$, '42501', 'insufficient_authority', 'junior cannot release survey report');
reset role;

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000007','role','int_compliance')::text, true);
set local role int_compliance;
select throws_ok($$select private.assert_authority('survey.report.release',null)$$, '42501', 'insufficient_authority', 'compliance cannot run survey transition');
reset role;

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000009','role','int_finance')::text, true);
set local role int_finance;
select lives_ok($$select private.assert_authority('billing.credit_note.approve',9000)$$, 'finance grade 4 passes 9000');
select throws_ok($$select private.assert_authority('billing.credit_note.approve',20000)$$, '42501', 'insufficient_authority', 'finance grade 4 fails 20000');
select is((select count(*) from api.my_authorities() where action_code='billing.credit_note.approve'), 1::bigint, 'finance sees its authority');
reset role;

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-00000000000a','role','int_finance')::text, true);
set local role int_finance;
select lives_ok($$select private.assert_authority('billing.credit_note.approve',20000)$$, 'finance grade 6 passes 20000');
reset role;

select private.emit_event('authz.denied.insufficient_authority', 'denied', 'authority_rule', null, null, null, jsonb_build_object('action', 'survey.report.release'));
select ok((select count(*) from audit_trail.event where event_type like 'authz.denied.%') >= 1, 'denials emit audit events');

select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select api.staff_position_close('a0000000-0000-0000-0000-000000000008','close junior');
select is((select status from iam.app_user where id='a0000000-0000-0000-0000-000000000008'), 'suspended', 'closing last position suspends user');
select api.staff_position_close('a0000000-0000-0000-0000-000000000002','close senior');
select is((select status from iam.app_user where id='a0000000-0000-0000-0000-000000000002'), 'active', 'manual assignment prevents suspension');

-- R3.3: assignable_roles centralized in database API
select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-00000000000b','role','int_sysadmin')::text, true);
select is((select count(*) from api.assignable_roles()), 9::bigint, 'sysadmin retrieves all internal assignable roles');
select is((select eligible from api.assignable_roles('a0000000-0000-0000-0000-00000000000c') where role_name = 'int_surveyor'), false, 'intern is not eligible for int_surveyor');
select is((select eligible from api.assignable_roles('a0000000-0000-0000-0000-000000000003') where role_name = 'int_surveyor'), true, 'principal surveyor is eligible for int_surveyor');

-- Non-sysadmin is denied from calling assignable_roles
select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select throws_ok($$select * from api.assignable_roles()$$, '42501', 'insufficient_authority', 'non-sysadmin cannot call assignable_roles');

-- R3.3 / Step 5: Proving title/grade alone does not grant regulated authority without active role
select set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-0000-0000-000000000003','role','int_viewer')::text, true);
set local role int_viewer;
select throws_ok($$select private.assert_authority('survey.report.release', null)$$, '42501', 'insufficient_authority', 'principal surveyor with int_viewer role cannot release survey report');
reset role;

select * from finish();
rollback;
