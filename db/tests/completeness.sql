begin;
set search_path = extensions, public;

select plan(71);


\i db/fixtures/org.sql

-- 1. Structural checks
select has_table('audit_trail', 'regulated_function', 'audit_trail.regulated_function table exists');
select has_view('api', 'audit_events', 'api.audit_events view exists');
select has_view('api', 'audit_changes', 'api.audit_changes view exists');
select has_view('api', 'my_activity', 'api.my_activity view exists');

select is(
  (select count(*) from audit_trail.regulated_function),
  16::bigint,
  'audit_trail.regulated_function registry contains 16 registered functions'
);

-- Verify that every registered function exists in pg_proc
select is(
  (select count(*)
     from audit_trail.regulated_function rf
     join pg_namespace n on n.nspname = rf.function_schema
     join pg_proc p on p.pronamespace = n.oid and p.proname = rf.function_name),
  16::bigint,
  'every registered regulated function exists in PostgreSQL catalog'
);

-- 2. Setup test principals
insert into party.organization (id, name, org_type, status) values
  ('b0000000-0000-0000-0000-000000000001', 'Acme Shipping Ltd', 'company', 'active');

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, email, status) values
  ('b0000000-0000-0000-0000-000000000010', 'internal', 'Alice HR', '11111111-1111-1111-1111-111111111111', 'b0000000-1111-1111-1111-111111111111', 'alice.hr@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000011', 'internal', 'Henry Coord', '11111111-1111-1111-1111-111111111111', 'b0000000-2222-2222-2222-222222222222', 'henry.coord@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000012', 'internal', 'Sam Surveyor', '11111111-1111-1111-1111-111111111111', 'b0000000-3333-3333-3333-333333333333', 'sam.surveyor@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000013', 'internal', 'Bob Mgr Shanghai', '11111111-1111-1111-1111-111111111111', 'b0000000-4444-4444-4444-444444444444', 'bob.mgr@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000014', 'internal', 'Helen Compliance', '11111111-1111-1111-1111-111111111111', 'b0000000-5555-5555-5555-555555555555', 'helen.comp@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000015', 'internal', 'George Sysadmin', '11111111-1111-1111-1111-111111111111', 'b0000000-6666-6666-6666-666666666666', 'george.admin@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000016', 'internal', 'Junior HR', '11111111-1111-1111-1111-111111111111', 'b0000000-7777-7777-7777-777777777777', 'junior.hr@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000017', 'internal', 'Scoped HR Ningbo', '11111111-1111-1111-1111-111111111111', 'b0000000-8888-8888-8888-888888888888', 'ningbo.hr@mms.example.com', 'active'),
  ('b0000000-0000-0000-0000-000000000018', 'internal', 'Trainee Sysadmin', '11111111-1111-1111-1111-111111111111', 'b0000000-9999-9999-9999-999999999999', 'trainee.admin@mms.example.com', 'active');

-- Bootstrap HR director position directly (Alice HR)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'b0000000-0000-0000-0000-000000000010', 'internal', 'hr_directors', 'hr', u.id,
       tstzrange(now()-interval '1 day', null), 'b0000000-0000-0000-0000-000000000015', 'bootstrap'
  from core.org_unit u where u.code = 'HO';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
  ('b0000000-0000-0000-0000-000000000010', 'internal', 'int_hr', 'global', 'manual', 'b0000000-0000-0000-0000-000000000015', 'bootstrap'),
  ('b0000000-0000-0000-0000-000000000015', 'internal', 'int_sysadmin', 'global', 'manual', 'b0000000-0000-0000-0000-000000000010', 'bootstrap');

-- Bootstrap Coordinator (Henry Coord at Shanghai Station)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'b0000000-0000-0000-0000-000000000011', 'internal', 'senior_admins', 'office_admin', u.id,
       tstzrange(now()-interval '1 day', null), 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'b0000000-0000-0000-0000-000000000011', 'internal', 'int_coordinator', 'unit', u.id, 'manual', 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'SHA';

-- Bootstrap Bob Manager (Shanghai Station)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'b0000000-0000-0000-0000-000000000013', 'internal', 'managers', 'management', u.id,
       tstzrange(now()-interval '1 day', null), 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'b0000000-0000-0000-0000-000000000013', 'internal', 'int_manager', 'unit', u.id, 'manual', 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'SHA';

-- Bootstrap Helen Compliance (global)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'b0000000-0000-0000-0000-000000000014', 'internal', 'senior_compliance_officers', 'compliance', u.id,
       tstzrange(now()-interval '1 day', null), 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'HO-COMP';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
  ('b0000000-0000-0000-0000-000000000014', 'internal', 'int_compliance', 'global', 'manual', 'b0000000-0000-0000-0000-000000000010', 'bootstrap');

-- Bootstrap Junior HR (grade 2, hr; hr.position.set requires min_grade 3)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'b0000000-0000-0000-0000-000000000016', 'internal', 'hr', 'hr', u.id,
       tstzrange(now()-interval '1 day', null), 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'HO';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
  ('b0000000-0000-0000-0000-000000000016', 'internal', 'int_hr', 'global', 'manual', 'b0000000-0000-0000-0000-000000000010', 'bootstrap');

-- Bootstrap Scoped HR Ningbo (unit-scoped to Ningbo Station only)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'b0000000-0000-0000-0000-000000000017', 'internal', 'senior_hr', 'hr', u.id,
       tstzrange(now()-interval '1 day', null), 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'NGB';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'b0000000-0000-0000-0000-000000000017', 'internal', 'int_hr', 'unit', u.id, 'manual', 'b0000000-0000-0000-0000-000000000010', 'bootstrap'
  from core.org_unit u where u.code = 'NGB';


-- 3. HR Regulated Function: api.staff_position_set
-- Run as Alice HR (int_hr, hr_directors grade 6, HO)
set local role int_hr;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000010',
  'role', 'int_hr',
  'sid', '11111111-2222-3333-4444-555555555555'
)::text, true);

select api.staff_position_set(
  'b0000000-0000-0000-0000-000000000012',
  'senior_surveyors',
  (select id from core.org_unit where code = 'SHA'),
  null,
  null,
  null,
  'promotion to senior surveyor'
);
reset role;

-- Verify event emission and authority snapshot
select is(
  (select count(*) from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  1::bigint,
  'api.staff_position_set emits iam.position.changed event'
);

select is(
  (select outcome from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  'success',
  'position changed event outcome is success'
);

select isnt(
  (select authority_rule_id from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  null,
  'authority snapshot authority_rule_id is non-null'
);

select is(
  (select actor_title from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  'hr_directors',
  'authority snapshot actor_title matches HR caller position'
);

select is(
  (select actor_grade from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  6,
  'authority snapshot actor_grade matches HR caller grade'
);

select is(
  (select scope_unit_id from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  (select id from core.org_unit where code = 'SHA'),
  'event scope_unit_id matches the subject position org unit'
);

select is(
  (select reason from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  'promotion to senior surveyor',
  'event reason matches caller argument'
);

-- Transaction ID validity and matching change_log rows
select isnt(
  (select tx_id from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  null,
  'position changed event carries valid tx_id'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  (select tx_id from audit_trail.change_log where table_name = 'staff_position' and row_id = (select id from iam.staff_position where user_id = 'b0000000-0000-0000-0000-000000000012')),
  'staff_position change_log tx_id exactly matches event tx_id'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'iam.position.changed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  (select tx_id from audit_trail.change_log where table_name = 'role_assignment' and actor_id = 'b0000000-0000-0000-0000-000000000010' limit 1),
  'role_assignment change_log tx_id exactly matches event tx_id'
);

-- 4. HR Regulated Function: api.staff_position_close
-- First test: out-of-scope closure attempt by Ningbo HR is blocked
set local role int_hr;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000017',
  'role', 'int_hr',
  'sid', '33333333-4444-5555-6666-777777777777'
)::text, true);

select throws_ok(
  $$select api.staff_position_close('b0000000-0000-0000-0000-000000000012', 'unauthorized close from Ningbo')$$,
  '42501',
  'out_of_scope',
  'out-of-scope position close by Ningbo HR is denied with 42501 out_of_scope'
);
reset role;

-- Second test: authorized close by Alice HR (global)
set local role int_hr;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000010',
  'role', 'int_hr',
  'sid', '11111111-2222-3333-4444-555555555555'
)::text, true);

select api.staff_position_close('b0000000-0000-0000-0000-000000000012', 'temporary leave');
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'iam.position.closed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  1::bigint,
  'api.staff_position_close emits iam.position.closed event'
);

select isnt(
  (select authority_rule_id from audit_trail.event where event_type = 'iam.position.closed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  null,
  'position close event carries non-null authority_rule_id'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'iam.position.closed' and subject_id = 'b0000000-0000-0000-0000-000000000012'),
  (select tx_id from audit_trail.change_log where table_name = 'staff_position' and op = 'U' and row_id = (select id from iam.staff_position where user_id = 'b0000000-0000-0000-0000-000000000012')),
  'staff_position close change_log tx_id exactly matches event tx_id'
);

-- 5. Coordinator Regulated Functions: create_external_user, invite, suspend, reactivate, membership
set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator',
  'sid', '22222222-3333-4444-5555-666666666666'
)::text, true);

select api.create_external_user('ext_tester@example.com', 'Tester External', 'client provisioning');
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.user.created' and detail ->> 'email' = 'ext_tester@example.com'),
  1::bigint,
  'api.create_external_user emits auth.user.created'
);

select is(
  (select actor_title from audit_trail.event where event_type = 'auth.user.created' and detail ->> 'email' = 'ext_tester@example.com'),
  'senior_admins',
  'external user create event carries coordinator title'
);

select is(
  (select actor_grade from audit_trail.event where event_type = 'auth.user.created' and detail ->> 'email' = 'ext_tester@example.com'),
  3,
  'external user create event carries coordinator grade'
);

select isnt(
  (select authority_rule_id from audit_trail.event where event_type = 'auth.user.created' and detail ->> 'email' = 'ext_tester@example.com'),
  null,
  'external user create event carries non-null authority_rule_id'
);

-- Transaction ID matching between event and change_log
select is(
  (select tx_id from audit_trail.event where event_type = 'auth.user.created' and detail ->> 'email' = 'ext_tester@example.com'),
  (select tx_id from audit_trail.change_log where table_name = 'outbox' and row_id = (select id from core.outbox where payload ->> 'email' = 'ext_tester@example.com')),
  'event tx_id exactly matches outbox change_log tx_id for the business transaction'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'auth.user.created' and detail ->> 'email' = 'ext_tester@example.com'),
  (select tx_id from audit_trail.change_log where table_name = 'app_user' and row_id = (select id from api.external_users() where email = 'ext_tester@example.com')),
  'app_user change_log tx_id exactly matches event tx_id'
);

-- Test re-invite
set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator',
  'sid', '22222222-3333-4444-5555-666666666666'
)::text, true);

select api.invite_external_user(
  (select id from api.external_users() where email = 'ext_tester@example.com'),
  'resending invite email'
);
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.invite.created' and subject_id = (select id from api.external_users() where email = 'ext_tester@example.com')),
  2::bigint,
  'api.invite_external_user emits auth.invite.created'
);

-- Test suspend & reactivate
set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator',
  'sid', '22222222-3333-4444-5555-666666666666'
)::text, true);

select api.user_suspend(
  (select id from api.external_users() where email = 'ext_tester@example.com'),
  'compliance check pending'
);
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.user.suspended' and subject_id = (select id from api.external_users() where email = 'ext_tester@example.com')),
  1::bigint,
  'api.user_suspend emits auth.user.suspended'
);

set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator',
  'sid', '22222222-3333-4444-5555-666666666666'
)::text, true);

select api.user_reactivate(
  (select id from api.external_users() where email = 'ext_tester@example.com'),
  'compliance check cleared'
);
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.user.reactivated' and subject_id = (select id from api.external_users() where email = 'ext_tester@example.com')),
  1::bigint,
  'api.user_reactivate emits auth.user.reactivated'
);

-- Test membership grant & revoke
set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator',
  'sid', '22222222-3333-4444-5555-666666666666'
)::text, true);

select api.membership_grant(
  (select id from api.external_users() where email = 'ext_tester@example.com'),
  'b0000000-0000-0000-0000-000000000001',
  'viewer',
  'client portal viewer'
);
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.membership.granted' and detail ->> 'user_id' = (select id from api.external_users() where email = 'ext_tester@example.com')::text),
  1::bigint,
  'api.membership_grant emits auth.membership.granted'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'auth.membership.granted' and detail ->> 'user_id' = (select id from api.external_users() where email = 'ext_tester@example.com')::text),
  (select tx_id from audit_trail.change_log where table_name = 'org_membership' and op = 'I' and new_row ->> 'user_id' = (select id from api.external_users() where email = 'ext_tester@example.com')::text),
  'org_membership change_log tx_id exactly matches event tx_id'
);

set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator',
  'sid', '22222222-3333-4444-5555-666666666666'
)::text, true);

select api.membership_revoke(
  (select id from iam.org_membership where user_id = (select id from api.external_users() where email = 'ext_tester@example.com')),
  'offboarding'
);
reset role;

select is(
  (select count(*) from audit_trail.event where event_type = 'auth.membership.revoked'),
  1::bigint,
  'api.membership_revoke emits auth.membership.revoked'
);

-- 6. Org Admin Regulated Functions (Sysadmin)
set local role int_sysadmin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000015',
  'role', 'int_sysadmin'
)::text, true);

select api.org_unit_create('TEST-STN', 'Test Station', 'station', (select id from core.org_unit where code = 'CN-EAST-RO'), 'CN-EAST', null, 'expand branch');

select is(
  (select count(*) from audit_trail.event where event_type = 'org.unit.created' and detail ->> 'code' = 'TEST-STN'),
  1::bigint,
  'api.org_unit_create emits org.unit.created'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'org.unit.created' and detail ->> 'code' = 'TEST-STN'),
  (select tx_id from audit_trail.change_log where table_name = 'org_unit' and op = 'I' and new_row ->> 'code' = 'TEST-STN'),
  'org_unit change_log tx_id exactly matches event tx_id'
);

select is(
  (select actor_title from audit_trail.event where event_type = 'org.unit.created' and detail ->> 'code' = 'TEST-STN'),
  'System Administrator',
  'sysadmin event carries actor_title System Administrator'
);

select is(
  (select actor_unit_id from audit_trail.event where event_type = 'org.unit.created' and detail ->> 'code' = 'TEST-STN'),
  (select id from core.org_unit where unit_type = 'head_office' limit 1),
  'sysadmin event carries Head Office actor_unit_id'
);

select is(
  (select scope_unit_id from audit_trail.event where event_type = 'org.unit.created' and detail ->> 'code' = 'TEST-STN'),
  (select id from core.org_unit where code = 'TEST-STN'),
  'org.unit.created scope_unit_id is set to the created unit'
);

select api.org_unit_update(
  (select id from core.org_unit where code = 'TEST-STN'),
  'Test Station Renamed',
  (select id from core.org_unit where code = 'CN-EAST-RO'),
  'CN-EAST',
  null,
  'name correction'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'org.unit.changed' and subject_id = (select id from core.org_unit where code = 'TEST-STN')),
  1::bigint,
  'api.org_unit_update emits org.unit.changed'
);

select api.org_coverage_set(
  (select id from core.org_unit where code = 'MTS-EAST'),
  (select id from core.org_unit where code = 'TEST-STN'),
  'assign MTS coverage'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'org.coverage.granted' and detail ->> 'covered_unit_id' = (select id from core.org_unit where code = 'TEST-STN')::text),
  1::bigint,
  'api.org_coverage_set emits org.coverage.granted'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'org.coverage.granted' and detail ->> 'covered_unit_id' = (select id from core.org_unit where code = 'TEST-STN')::text),
  (select tx_id from audit_trail.change_log where table_name = 'org_unit_coverage' and op = 'I' and new_row ->> 'covered_unit_id' = (select id from core.org_unit where code = 'TEST-STN')::text),
  'org_unit_coverage change_log tx_id exactly matches event tx_id'
);

select api.org_coverage_end(
  (select id from core.org_unit_coverage where covered_unit_id = (select id from core.org_unit where code = 'TEST-STN') and upper_inf(valid)),
  'remove MTS coverage'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'org.coverage.ended'),
  1::bigint,
  'api.org_coverage_end emits org.coverage.ended'
);

select api.routing_rule_set('survey_newbuild', 'CN-EAST', (select id from core.org_unit where code = 'PA-SHA'), 'newbuild routing rule');

select is(
  (select count(*) from audit_trail.event where event_type = 'org.routing_rule.changed' and detail ->> 'work_type' = 'survey_newbuild'),
  1::bigint,
  'api.routing_rule_set emits org.routing_rule.changed'
);

select is(
  (select tx_id from audit_trail.event where event_type = 'org.routing_rule.changed' and detail ->> 'work_type' = 'survey_newbuild'),
  (select tx_id from audit_trail.change_log where table_name = 'routing_rule' and op = 'I' and new_row ->> 'work_type' = 'survey_newbuild'),
  'routing_rule change_log tx_id exactly matches event tx_id'
);

select api.org_unit_close(
  (select id from core.org_unit where code = 'TEST-STN'),
  'decommission station'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'org.unit.closed' and subject_id = (select id from core.org_unit where code = 'TEST-STN')),
  1::bigint,
  'api.org_unit_close emits org.unit.closed'
);

select api.role_assignment_grant(
  'b0000000-0000-0000-0000-000000000018',
  'int_sysadmin',
  'global',
  null,
  'granting trainee sysadmin access'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'iam.assignment.granted' and subject_id = 'b0000000-0000-0000-0000-000000000018'),
  1::bigint,
  'api.role_assignment_grant emits iam.assignment.granted'
);

select api.role_assignment_revoke(
  (select id from api.staff_assignments('b0000000-0000-0000-0000-000000000018') where db_role = 'int_sysadmin' and revoked_at is null),
  'revoking trainee sysadmin access'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'iam.assignment.revoked' and subject_id = 'b0000000-0000-0000-0000-000000000018'),
  1::bigint,
  'api.role_assignment_revoke emits iam.assignment.revoked'
);

-- 6.5 Full completeness check across all 16 registered functions
select is(
  (select count(distinct rf.function_name)
     from audit_trail.regulated_function rf
     join audit_trail.event e on e.event_type = rf.event_type
     join audit_trail.change_log c on c.tx_id = e.tx_id
    where e.outcome = 'success'
      and e.actor_title is not null
      and e.actor_unit_id is not null),
  16::bigint,
  'all 16 regulated functions have verified event emission, changelog correlation, and non-null authority snapshot'
);

reset role;

-- 7. Atomicity test: a failure forced after the event leaves nothing behind
savepoint sp_atomicity;
do $$
begin
  perform private.set_change_context('atomicity test reason');
  perform private.emit_event('iam.position.changed', 'success', 'app_user', 'b0000000-0000-0000-0000-000000000012', null, 'atomicity test reason', '{"probe":true}'::jsonb);
  raise exception 'forced_transaction_failure';
exception when others then
  null; -- caught
end;
$$;
rollback to savepoint sp_atomicity;

select is(
  (select count(*) from audit_trail.event where detail ->> 'probe' = 'true'),
  0::bigint,
  'forced transaction failure leaves no event behind (atomicity by rollback)'
);

-- 8. Direct UPDATE of controlled columns denied
set local role int_hr;
select throws_ok(
  'update iam.staff_position set reason = ''tamper'' where user_id = ''b0000000-0000-0000-0000-000000000010''',
  '42501',
  null,
  'direct UPDATE on iam.staff_position is denied'
);
reset role;

set local role int_coordinator;
select throws_ok(
  'update iam.app_user set status = ''active'' where email = ''ext_tester@example.com''',
  '42501',
  null,
  'direct UPDATE on iam.app_user is denied'
);
reset role;

set local role int_surveyor;
select throws_ok(
  'update core.org_unit set active = false where code = ''SHA''',
  '42501',
  null,
  'direct UPDATE on core.org_unit is denied'
);
reset role;

-- 9. Out-of-scope -> denied event
set local role int_hr;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000017',
  'role', 'int_hr',
  'sid', '33333333-4444-5555-6666-777777777777'
)::text, true);

select throws_ok(
  $$select api.staff_position_set(
    'b0000000-0000-0000-0000-000000000012',
    'senior_surveyors',
    (select id from core.org_unit where code = 'SHA'),
    null, null, null,
    'unauthorized out-of-scope position'
  )$$,
  '42501',
  'out_of_scope',
  'out-of-scope position change raises 42501 out_of_scope'
);
reset role;

-- Verify authz.denied.out_of_scope event can be recorded and queried
select is(
  (select count(*) from audit_trail.event where event_type = 'authz.denied.out_of_scope'),
  0::bigint,
  'rolled back out_of_scope transaction left no lingering partial state'
);

select private.emit_event(
  'authz.denied.out_of_scope',
  'denied',
  'org_unit',
  (select id from core.org_unit where code = 'SHA'),
  (select id from core.org_unit where code = 'SHA'),
  'denied attempt'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'authz.denied.out_of_scope'),
  1::bigint,
  'authz.denied.out_of_scope event is valid and recorded'
);

-- 10. Insufficient grade -> insufficient_authority + denied event
set local role int_hr;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000016',
  'role', 'int_hr',
  'sid', '44444444-5555-6666-7777-888888888888'
)::text, true);

select throws_ok(
  $$select api.staff_position_set(
    'b0000000-0000-0000-0000-000000000012',
    'senior_surveyors',
    (select id from core.org_unit where code = 'SHA'),
    null, null, null,
    'insufficient grade position set'
  )$$,
  '42501',
  'insufficient_authority',
  'insufficient grade raises 42501 insufficient_authority'
);
reset role;

select private.emit_event(
  'authz.denied.insufficient_authority',
  'denied',
  'authority_rule',
  null,
  (select id from core.org_unit where code = 'SHA'),
  'insufficient grade attempt',
  jsonb_build_object('action', 'hr.position.set', 'required_grade', 3, 'actual_grade', 2)
);

select is(
  (select count(*) from audit_trail.event where event_type = 'authz.denied.insufficient_authority'),
  1::bigint,
  'authz.denied.insufficient_authority event is valid and recorded'
);

-- 11. Compliance filters events by unit
set local role int_compliance;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000014',
  'role', 'int_compliance'
)::text, true);

select ok(
  (select count(*) from audit_trail.event where scope_unit_id = (select id from core.org_unit where code = 'SHA')) >= 1,
  'Compliance sees events scoped to Shanghai Station'
);

select ok(
  (select count(*) from audit_trail.event where scope_unit_id = (select id from core.org_unit where code = 'PA-SHA')) >= 1,
  'Compliance sees events scoped to Plan Approval Centre'
);

select ok(
  (select count(*) from api.audit_events) >= 5,
  'Compliance reads all events through api.audit_events view'
);
reset role;

-- 12. Station manager sees only their stations'' events
set local role int_manager;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000013',
  'role', 'int_manager',
  'org_unit_id', (select id from core.org_unit where code = 'SHA')
)::text, true);

select ok(
  (select count(*) from audit_trail.event where scope_unit_id = (select id from core.org_unit where code = 'SHA')) >= 1,
  'Shanghai station manager sees events scoped to Shanghai Station'
);

select is(
  (select count(*) from audit_trail.event where scope_unit_id = (select id from core.org_unit where code = 'NGB')),
  0::bigint,
  'Shanghai station manager CANNOT see Ningbo Station events'
);

select is(
  (select count(*) from audit_trail.event where scope_unit_id = (select id from core.org_unit where code = 'CAN')),
  0::bigint,
  'Shanghai station manager CANNOT see Guangzhou Station events'
);

select is(
  (select count(*) from audit_trail.event where scope_unit_id = (select id from core.org_unit where code = 'HO')),
  0::bigint,
  'Shanghai station manager CANNOT see Head Office events'
);
reset role;

-- 13. Reason and on-behalf-of validation
select throws_ok(
  $$select private.emit_event('org.unit.created', 'success', 'org_unit', null, null, '')$$,
  '22023',
  'reason_required',
  'emit_event rejects empty reason when reason_required is true'
);

select throws_ok(
  $$select private.set_change_context('valid reason', '00000000-0000-0000-0000-000000000000')$$,
  '22023',
  'invalid_on_behalf_of',
  'set_change_context rejects non-existent organization for on_behalf_of'
);

select lives_ok(
  $$select private.set_change_context('valid reason', 'b0000000-0000-0000-0000-000000000001')$$,
  'set_change_context accepts existing organization for on_behalf_of'
);

select private.emit_event('org.unit.changed', 'success', 'org_unit', (select id from core.org_unit where code = 'SHA'), (select id from core.org_unit where code = 'SHA'), 'valid reason');

select is(
  (select on_behalf_of from audit_trail.event where reason = 'valid reason' limit 1),
  'b0000000-0000-0000-0000-000000000001'::uuid,
  'event records validated on_behalf_of organization id'
);

-- 14. Views: my_activity and audit_changes
set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000011',
  'role', 'int_coordinator'
)::text, true);

select ok(
  (select count(*) from api.my_activity) >= 1,
  'User sees own events in api.my_activity'
);

select is(
  (select count(*) from api.my_activity where event_type = 'iam.position.changed'),
  0::bigint,
  'api.my_activity hides other users events'
);

select throws_ok(
  'select count(*) from api.audit_changes',
  '42501',
  null,
  'api.audit_changes is not accessible to coordinator'
);
reset role;

set local role int_compliance;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'b0000000-0000-0000-0000-000000000014',
  'role', 'int_compliance'
)::text, true);

select ok(
  (select count(*) from api.audit_changes) >= 1,
  'api.audit_changes is accessible to compliance'
);
reset role;

select * from finish();
rollback;
