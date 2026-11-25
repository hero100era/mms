begin;
set search_path = extensions, public;
select plan(42);
\i db/fixtures/org.sql

insert into iam.app_user (id, kind, display_name, email, entra_tenant_id, entra_object_id, status) values
  ('b0000000-0000-0000-0000-000000000001','internal','HR User',null,'11111111-1111-1111-1111-111111111111','b0000000-1111-1111-1111-111111111111','active'),
  ('b0000000-0000-0000-0000-000000000002','internal','Station Surveyor',null,'11111111-1111-1111-1111-111111111111','b0000000-2222-2222-2222-222222222222','active'),
  ('b0000000-0000-0000-0000-000000000003','internal','Station Manager',null,'11111111-1111-1111-1111-111111111111','b0000000-3333-3333-3333-333333333333','active'),
  ('b0000000-0000-0000-0000-000000000004','internal','Station Coord 1',null,'11111111-1111-1111-1111-111111111111','b0000000-4444-4444-4444-444444444444','active'),
  ('b0000000-0000-0000-0000-000000000005','internal','Station Coord 2',null,'11111111-1111-1111-1111-111111111111','b0000000-5555-5555-5555-555555555555','active'),
  ('b0000000-0000-0000-0000-000000000006','internal','PAC Manager',null,'11111111-1111-1111-1111-111111111111','b0000000-6666-6666-6666-666666666666','active'),
  ('b0000000-0000-0000-0000-000000000007','internal','Compliance Off',null,'11111111-1111-1111-1111-111111111111','b0000000-7777-7777-7777-777777777777','active'),
  ('b0000000-0000-0000-0000-000000000008','internal','Finance Off',null,'11111111-1111-1111-1111-111111111111','b0000000-8888-8888-8888-888888888888','active'),
  ('b0000000-0000-0000-0000-000000000009','internal','Sysadmin User',null,'11111111-1111-1111-1111-111111111111','b0000000-9999-9999-9999-999999999999','active'),
  ('b0000000-0000-0000-0000-00000000000a','external','External Client','ext_client_b@example.com',null,null,'active'),
  ('b0000000-0000-0000-0000-00000000000b','internal','MTS Engineer',null,'11111111-1111-1111-1111-111111111111','b0000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb','active');

-- Setup HR bootstrap position
insert into iam.staff_position (user_id,user_kind,job_title_code,job_family,unit_id,valid,set_by,reason)
select 'b0000000-0000-0000-0000-000000000001','internal','hr_directors','hr',u.id,
       tstzrange(now()-interval '1 day',null),'b0000000-0000-0000-0000-000000000002','bootstrap'
  from core.org_unit u where u.code='HO';

insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,source,granted_by,grant_reason) values
  ('b0000000-0000-0000-0000-000000000001','internal','int_hr','global','manual','b0000000-0000-0000-0000-000000000002','bootstrap'),
  ('b0000000-0000-0000-0000-000000000009','internal','int_sysadmin','global','manual','b0000000-0000-0000-0000-000000000001','bootstrap');

-- HR sets up the positions
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);

select api.staff_position_set('b0000000-0000-0000-0000-000000000002','senior_surveyors',(select id from core.org_unit where code='SHA'),null,null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-000000000003','managers',(select id from core.org_unit where code='SHA'),null,null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-000000000004','admins',(select id from core.org_unit where code='SHA'),'office_admin',null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-000000000005','admins',(select id from core.org_unit where code='SHA'),'office_admin',null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-000000000006','managers',(select id from core.org_unit where code='PA-SHA'),null,null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-000000000007','senior_compliance_officers',(select id from core.org_unit where code='HO-COMP'),null,null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-000000000008','finance_managers',(select id from core.org_unit where code='HO'),null,null,now(),'setup');
select api.staff_position_set('b0000000-0000-0000-0000-00000000000b','engineers',(select id from core.org_unit where code='MTS-EAST'),'mts',null,now(),'setup');

-- Setup test organization and fleet
insert into party.organization (id, name, org_type, status) values
  ('b0000000-0000-0000-0000-0000000000c1', 'COSCO Shipping', 'company', 'active');

insert into fleet.ship (id, imo_number, name, ship_type, flag_code, gross_tonnage, build_year, status) values
  ('b0000000-0000-0000-0000-000000000051', '9876543', 'COSCO Prosperity', 'bulk_carrier', 'PA', 40000, 2020, 'in_service');

insert into fleet.ship_party (ship_id, org_id, party_role, valid) values
  ('b0000000-0000-0000-0000-000000000051', 'b0000000-0000-0000-0000-0000000000c1', 'registered_owner', tstzrange(now() - interval '1 year', null));

-- Grant external client membership
insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by)
values ('b0000000-0000-0000-0000-00000000000a', 'external', 'b0000000-0000-0000-0000-0000000000c1', 'requester', 'b0000000-0000-0000-0000-000000000001');

-- -------------------------------------------------------------
-- Dimension 1 & 2: Station Manager Scope & Authority
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000003','role','int_manager')::text, true);
select lives_ok($$select private.assert_in_scope((select id from core.org_unit where code='SHA'))$$, 'Case 1: Station manager can act in own station');
select throws_ok($$select private.assert_in_scope((select id from core.org_unit where code='NGB'))$$, '42501', 'out_of_scope', 'Case 1: Station manager cannot act in another station');
select lives_ok($$select private.assert_authority('survey.job.assign')$$, 'Case 1: Station manager has survey.job.assign authority');
select throws_ok($$select private.assert_authority('survey.report.release')$$, '42501', 'insufficient_authority', 'Case 1: Station manager cannot release survey report');

-- -------------------------------------------------------------
-- Case 2: Centralized Plan Approval Centre (PAC)
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000006','role','int_manager')::text, true);
select lives_ok($$select private.assert_authority('plan.submission.reroute')$$, 'Case 2: PAC manager has plan.submission.reroute authority');
select throws_ok($$select private.assert_authority('survey.request.triage')$$, '42501', 'insufficient_authority', 'Case 2: PAC manager cannot triage survey requests');

-- -------------------------------------------------------------
-- Case 3: Centralized MTS
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-00000000000b','role','int_viewer')::text, true);
select ok((select count(*) from private.my_units()) >= 1, 'Case 3: MTS engineer has units resolved via coverage');

-- -------------------------------------------------------------
-- Case 4: Head Office Compliance
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000007','role','int_compliance')::text, true);
select lives_ok($$select private.assert_authority('audit_trail.trail.read')$$, 'Case 4: HO Compliance has worldwide audit trail read authority');
select lives_ok($$select private.assert_authority('compliance.finding.raise')$$, 'Case 4: HO Compliance can raise compliance findings');
select lives_ok($$select private.assert_authority('compliance.record.hold')$$, 'Case 4: HO Compliance can place record on hold');
select throws_ok($$select private.assert_authority('survey.request.triage')$$, '42501', 'insufficient_authority', 'Case 4: HO Compliance has NO implicit operational triage authority');
select throws_ok($$select private.assert_authority('survey.report.release')$$, '42501', 'insufficient_authority', 'Case 4: HO Compliance has NO report release authority');

-- -------------------------------------------------------------
-- Case 5: Sysadmin (R6.3: Separation of Duties & Check Constraint)
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000009','role','int_sysadmin')::text, true);
select throws_ok($$select private.assert_authority('survey.request.triage')$$, '42501', 'insufficient_authority', 'Case 5: Sysadmin cannot triage survey requests');
select throws_ok($$select private.assert_authority('survey.job.assign')$$, '42501', 'insufficient_authority', 'Case 5: Sysadmin cannot assign survey jobs');
select throws_ok($$select private.assert_authority('survey.report.release')$$, '42501', 'insufficient_authority', 'Case 5: Sysadmin cannot release survey reports');
select throws_ok($$select private.assert_authority('billing.credit_note.approve', 1000)$$, '42501', 'insufficient_authority', 'Case 5: Sysadmin cannot approve credit notes');
select throws_ok($$select private.assert_authority('hr.position.set')$$, '42501', 'insufficient_authority', 'Case 5: Sysadmin cannot set HR positions');

-- Test database constraint authority_rule_sysadmin_ck
select throws_ok(
  $$insert into iam.authority_rule (action_code, db_role, min_grade) values ('survey.request.triage', 'int_sysadmin', 1)$$,
  '23514', null, 'authority_rule_sysadmin_ck prevents inserting business approval rule for sysadmin'
);
select throws_ok(
  $$insert into iam.authority_rule (action_code, db_role, min_grade) values ('hr.position.set', 'int_sysadmin', 1)$$,
  '23514', null, 'authority_rule_sysadmin_ck prevents inserting HR rule for sysadmin'
);

-- -------------------------------------------------------------
-- Case 6: External Customer Organization Scope
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-00000000000a','role','ext_user')::text, true);
select is((select array_agg(id) from party.organization where id='b0000000-0000-0000-0000-0000000000c1'), (select private.my_org_ids()), 'Case 6: External user is scoped to authorized org COSCO');
select throws_ok($$select private.assert_authority('survey.request.triage')$$, '42501', null, 'Case 6: External user cannot call internal assert_authority');

-- -------------------------------------------------------------
-- R6.3: Segregation of Duties - Four-Eyes Review (Creator Cannot Approve)
-- -------------------------------------------------------------
-- Station Coordinator 1 creates a survey request
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000004','role','int_coordinator')::text, true);

create temp table test_sr as
select api.survey_request_create(
  'b0000000-0000-0000-0000-000000000051'::uuid,
  'b0000000-0000-0000-0000-0000000000c1'::uuid,
  (select id from core.org_unit where code='SHA'),
  'Shanghai Port', 'CN', 'CNSHA',
  now()+interval '1 day', now()+interval '3 days',
  array['hull'], 'Annual survey', '{}'::jsonb
) as req_id;

select api.survey_request_submit((select req_id from test_sr), 'Coord 1 submits');

-- Four-eyes violation: Coord 1 tries to accept their OWN survey request
select throws_ok(
  format('select api.survey_request_accept(%L, %L, %L)', (select req_id from test_sr), 'acceptance test', 'notes'),
  '42501', 'creator_cannot_approve', 'R6.3: Creator cannot approve their own survey request (four-eyes review)'
);

-- Four-eyes compliance: Coord 2 accepts the survey request created by Coord 1
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000005','role','int_coordinator')::text, true);
select lives_ok(
  format('select api.survey_request_accept(%L, %L, %L)', (select req_id from test_sr), 'Four-eyes acceptance by Coord 2', 'notes'),
  'R6.3: Second coordinator successfully accepts the request'
);

-- -------------------------------------------------------------
-- R6.3: Segregation of Duties - Position Proposal Proposer Cannot Confirm
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);

-- HR user 1 proposes a position for Station Surveyor
create temp table test_prop as
select private.position_proposal_record(
  'b0000000-0000-0000-0000-000000000002',
  'principal_surveyors', 'Survey', 'SHA', '{}'::jsonb,
  'b0000000-0000-0000-0000-000000000001'
) as prop_id;

-- Proposer cannot confirm their own proposal
select throws_ok(
  format('select api.position_proposal_confirm(%L, %L, %L, null, %L)',
    (select prop_id from test_prop), 'principal_surveyors', (select id from core.org_unit where code='SHA'), 'self confirm'),
  '42501', 'cannot_confirm_own_proposal', 'R6.3: Proposer cannot confirm own position proposal'
);

-- User cannot confirm proposal for themselves
update iam.position_proposal set user_id = 'b0000000-0000-0000-0000-000000000001', proposed_by = 'b0000000-0000-0000-0000-000000000002'
where id = (select prop_id from test_prop);

select throws_ok(
  format('select api.position_proposal_confirm(%L, %L, %L, null, %L)',
    (select prop_id from test_prop), 'hr_directors', (select id from core.org_unit where code='HO'), 'self confirm user'),
  '42501', 'cannot_confirm_own_proposal', 'R6.3: User cannot confirm position proposal for themselves'
);

-- -------------------------------------------------------------
-- R6.3: Qualification Approver Cannot Self-Approve
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000001','role','int_hr')::text, true);

select throws_ok(
  $$select api.staff_qualification_grant('b0000000-0000-0000-0000-000000000001', 'hull_basic', now(), null, 'self grant')$$,
  '42501', 'cannot_grant_self', 'R6.3: Qualification approver cannot self-approve qualification'
);

-- HR grants qualification to surveyor for revocation tests
create temp table test_qual as
select api.staff_qualification_grant('b0000000-0000-0000-0000-000000000002', 'survey.report.countersign', now(), null, 'grant for test') as qual_id;

-- Holder cannot self-revoke qualification
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000002','role','int_hr')::text, true);
select throws_ok(
  format('select api.staff_qualification_revoke(%L, %L)', (select qual_id from test_qual), 'self revoke'),
  '42501', 'cannot_revoke_self', 'R6.3: Qualification holder cannot self-revoke qualification'
);

-- Sysadmin cannot grant qualifications
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000009','role','int_sysadmin')::text, true);
select throws_ok(
  $$select api.staff_qualification_grant('b0000000-0000-0000-0000-000000000002', 'hull_basic', now(), null, 'sysadmin grant')$$,
  '42501', 'insufficient_authority', 'R6.3: Sysadmin cannot grant qualifications'
);

-- -------------------------------------------------------------
-- R6.3: Break-Glass Cannot Approve / Release / Sign
-- -------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object(
  'sub','b0000000-0000-0000-0000-000000000009','role','int_sysadmin','src','break_glass','bg',extract(epoch from now()+interval '1 hour')::bigint
)::text, true);

select throws_ok(
  $$select private.assert_authority('survey.request.triage')$$,
  '42501', 'break_glass_forbidden_operation', 'R6.3: Break-glass cannot perform survey triage'
);
select throws_ok(
  $$select private.assert_authority('survey.report.release')$$,
  '42501', 'break_glass_forbidden_operation', 'R6.3: Break-glass cannot release survey reports'
);
select throws_ok(
  $$select api.staff_qualification_grant('b0000000-0000-0000-0000-000000000002', 'hull_basic', now(), null, 'bg grant')$$,
  '42501', 'break_glass_forbidden_operation', 'R6.3: Break-glass cannot grant qualifications'
);

-- -------------------------------------------------------------
-- R6.2: Authority-Decision Explanation Diagnostics (api.explain_authority)
-- -------------------------------------------------------------
-- 1. Valid authorization returns allowed=true, reason_code='ok'
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000004','role','int_coordinator')::text, true);
select is(
  (select allowed from api.explain_authority('survey.request.triage')),
  true,
  'R6.2: explain_authority reports allowed=true for eligible coordinator'
);
select is(
  (select reason_code from api.explain_authority('survey.request.triage')),
  'ok',
  'R6.2: explain_authority reports reason_code=ok'
);

-- 2. Creator attempting to approve returns creator_cannot_approve
select is(
  (select reason_code from api.explain_authority('survey.request.triage', null, null, (select req_id from test_sr))),
  'creator_cannot_approve',
  'R6.2: explain_authority diagnoses creator_cannot_approve'
);

-- 3. Out of scope unit returns out_of_scope
select is(
  (select reason_code from api.explain_authority('survey.request.triage', null, (select id from core.org_unit where code='NGB'))),
  'out_of_scope',
  'R6.2: explain_authority diagnoses out_of_scope'
);

-- 4. Sysadmin checking business approval returns sysadmin_cannot_approve
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000009','role','int_sysadmin')::text, true);
select is(
  (select reason_code from api.explain_authority('survey.request.triage')),
  'sysadmin_cannot_approve',
  'R6.2: explain_authority diagnoses sysadmin_cannot_approve for sysadmin'
);
select is(
  (select reason_code from api.explain_authority('cert.issue')),
  'sysadmin_cannot_approve',
  'R6.2: explain_authority diagnoses sysadmin_cannot_approve for cert.issue under sysadmin'
);

-- 4b. Qualification revocation explanation diagnoses cannot_revoke_self
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000002','role','int_hr')::text, true);
select is(
  (select reason_code from api.explain_authority('qual.revoke', null, null, (select qual_id from test_qual))),
  'cannot_revoke_self',
  'R6.2: explain_authority diagnoses cannot_revoke_self when qual belongs to caller'
);

-- 5. Missing qualification returns qualification_required
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000002','role','int_surveyor')::text, true);
select is(
  (select reason_code from api.explain_authority('survey.report.release')),
  'qualification_required',
  'R6.2: explain_authority diagnoses qualification_required when surveyor lacks qualification'
);

-- 6. Financial amount exceeded
select set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-0000-0000-000000000008','role','int_finance')::text, true);
select is(
  (select reason_code from api.explain_authority('billing.credit_note.approve', 50000)),
  'amount_exceeded',
  'R6.2: explain_authority diagnoses amount_exceeded when limit breached'
);
select is(
  (select allowed from api.explain_authority('billing.credit_note.approve', 5000)),
  true,
  'R6.2: explain_authority confirms allowed=true within limit'
);

-- 7. Break-glass explains break_glass_forbidden
select set_config('request.jwt.claims', json_build_object(
  'sub','b0000000-0000-0000-0000-000000000009','role','int_sysadmin','src','break_glass','bg',extract(epoch from now()+interval '1 hour')::bigint
)::text, true);
select is(
  (select reason_code from api.explain_authority('survey.report.release')),
  'break_glass_forbidden',
  'R6.2: explain_authority diagnoses break_glass_forbidden under break-glass'
);

select * from finish();
rollback;
