begin;
set search_path = extensions, public;

select plan(31);

\i db/fixtures/org.sql

-- H-13: positions proposed from directory attributes, confirmed by HR.
insert into iam.app_user (id, kind, display_name, email, entra_tenant_id, entra_object_id, status) values
  ('a5000000-0000-0000-0000-000000000001','internal','HR Admin','hr@example.com','11111111-1111-1111-1111-111111111111','a5000000-1111-1111-1111-111111111111','active'),
  ('a5000000-0000-0000-0000-000000000002','internal','New Starter','starter@example.com','11111111-1111-1111-1111-111111111111','a5000000-2222-2222-2222-222222222222','active'),
  ('a5000000-0000-0000-0000-000000000003','internal','Second Starter','starter2@example.com','11111111-1111-1111-1111-111111111111','a5000000-3333-3333-3333-333333333333','active');

-- HR itself is bootstrapped directly; set_by must differ from the user.
insert into iam.staff_position (user_id,user_kind,job_title_code,job_family,unit_id,valid,set_by,reason)
select 'a5000000-0000-0000-0000-000000000001','internal','hr_directors','hr',u.id,
       tstzrange(now()-interval '1 day',null),'a5000000-0000-0000-0000-000000000002','bootstrap'
  from core.org_unit u where u.code='HO';
insert into iam.role_assignment (user_id,user_kind,db_role,scope_type,source,granted_by,grant_reason)
values ('a5000000-0000-0000-0000-000000000001','internal','int_hr','global','manual',
        'a5000000-0000-0000-0000-000000000002','bootstrap');

select has_table('iam', 'position_proposal', 'iam.position_proposal exists');
select has_column('iam', 'position_proposal', 'entra_department', 'proposal keeps the raw department attribute');

-- 1. The sync worker stages a proposal; it never creates a position.
set role worker;
select set_config('request.jwt.claims', '', true);

select lives_ok(
  $$select private.position_proposal_record(
      'a5000000-0000-0000-0000-000000000002','senior_surveyors','Survey','SHA')$$,
  'worker stages a proposal from directory attributes'
);

reset role;
select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000001','role','int_hr')::text, true);

select is(
  (select status from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  'pending', 'a staged proposal is pending'
);
select is(
  (select job_title_code from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  'senior_surveyors', 'an exact job title code is offered as the guess'
);
select is(
  (select unit_id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  (select id from core.org_unit where code = 'SHA'), 'an exact unit code is offered as the guess'
);
select is(
  (select count(*) from iam.staff_position where user_id = 'a5000000-0000-0000-0000-000000000002'),
  0::bigint, 'staging a proposal creates no position'
);

-- 2. Re-staging the same person refreshes one pending row instead of piling up.
-- The expected id is read while still HR: the worker role cannot see iam at all, which
-- is the point of the grants.
select id as pending_proposal_id from iam.position_proposal
 where user_id = 'a5000000-0000-0000-0000-000000000002';
\gset

set role worker;
select set_config('request.jwt.claims', '', true);
select is(
  private.position_proposal_record(
    'a5000000-0000-0000-0000-000000000002','senior_surveyors','Survey','SHA'),
  :'pending_proposal_id'::uuid,
  're-staging returns the existing pending proposal'
);
reset role;

select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select is(
  (select count(*) from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  1::bigint, 'a person has at most one pending proposal'
);

-- 3. A directory title that is not an exact code stays unmapped; HR fills it in.
set role worker;
select set_config('request.jwt.claims', '', true);
select private.position_proposal_record(
  'a5000000-0000-0000-0000-000000000003','Senior Surveyor (Asia)','Surveys','Overseas');
reset role;

select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select is(
  (select job_title_code from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'),
  null::text, 'a free-text directory title is not guessed'
);
select is(
  (select entra_job_title from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'),
  'Senior Surveyor (Asia)', 'the raw attribute is kept for the reviewer'
);

-- 4. Only the directory sync or a human administrator may stage.
select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000002','role','int_surveyor')::text, true);
select throws_ok(
  $$select private.position_proposal_record('a5000000-0000-0000-0000-000000000002','x',null,null)$$,
  '42501', 'worker_or_admin_role_required',
  'a surveyor cannot stage a proposal'
);
select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
select throws_ok(
  $$select private.position_proposal_record('a5000000-0000-0000-0000-000000000099','x',null,null)$$,
  'P0001', 'internal_user_not_found',
  'an unknown person cannot be proposed'
);

-- 5. Confirmation goes through the ordinary position path and needs real values.
select throws_ok(
  format('select api.position_proposal_confirm(%L, null, null, null, %L)',
    (select id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'), ''),
  '22023', 'reason_required',
  'confirming without a reason is refused'
);

select throws_ok(
  format('select api.position_proposal_confirm(%L, null, null, null, %L)',
    (select id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'),
    'confirmed after checking the offer letter'),
  '22023', 'position_proposal_incomplete',
  'an unmapped proposal needs a title and a unit before it can be confirmed'
);

select lives_ok(
  format('select api.position_proposal_confirm(%L, %L, %L, null, %L)',
    (select id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
    'senior_surveyors', (select id from core.org_unit where code = 'SHA'),
    'confirmed against the signed contract'),
  'HR confirms a proposal with a title and a unit'
);

select is(
  (select count(*) from iam.staff_position where user_id = 'a5000000-0000-0000-0000-000000000002' and upper(valid) is null),
  1::bigint, 'confirming creates exactly one live position'
);
select is(
  (select job_title_code from iam.staff_position where user_id = 'a5000000-0000-0000-0000-000000000002' and upper(valid) is null),
  'senior_surveyors', 'the position carries the confirmed title'
);
select is(
  (select status from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  'confirmed', 'the proposal records its decision'
);
select is(
  (select staff_position_id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  (select id from iam.staff_position where user_id = 'a5000000-0000-0000-0000-000000000002' and upper(valid) is null),
  'the proposal points at the position it produced'
);
select is(
  (select decided_by from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
  'a5000000-0000-0000-0000-000000000001'::uuid, 'the decision names the reviewer'
);

select throws_ok(
  format('select api.position_proposal_confirm(%L, %L, %L, null, %L)',
    (select id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000002'),
    'senior_surveyors', (select id from core.org_unit where code = 'SHA'),
    'trying again'),
  '22023', 'position_proposal_already_decided',
  'a confirmed proposal cannot be confirmed twice'
);

-- 6. Rejection is a decision too, and creates nothing.
select lives_ok(
  format('select api.position_proposal_reject(%L, %L)',
    (select id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'),
    'the applicant declined the offer'),
  'HR rejects a proposal'
);
select is(
  (select status from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'),
  'rejected', 'the rejected proposal records its status'
);
select is(
  (select count(*) from iam.staff_position where user_id = 'a5000000-0000-0000-0000-000000000003'),
  0::bigint, 'rejecting creates no position'
);
select throws_ok(
  format('select api.position_proposal_reject(%L, %L)',
    (select id from iam.position_proposal where user_id = 'a5000000-0000-0000-0000-000000000003'),
    'trying again'),
  '22023', 'position_proposal_already_decided',
  'a rejected proposal cannot be rejected twice'
);

-- 7. Both decisions leave an audit trail naming the person.
select is(
  (select count(*) from audit_trail.event
    where event_type = 'iam.position.proposal_confirmed'
      and subject_id = 'a5000000-0000-0000-0000-000000000002'),
  1::bigint, 'confirming emits an audit event for the person'
);
select is(
  (select count(*) from audit_trail.event
    where event_type = 'iam.position.proposal_rejected'
      and subject_id = 'a5000000-0000-0000-0000-000000000003'),
  1::bigint, 'rejecting emits an audit event for the person'
);

-- 8. The queue is HR work: a surveyor holds no grant on it. PostgREST sets the role, so
-- the test does too; a claim alone never changes what the database allows.
select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000002','role','int_surveyor')::text, true);
set role int_surveyor;
select throws_ok(
  $$select count(*) from iam.position_proposal$$,
  '42501', null,
  'a surveyor cannot read the proposal queue'
);
reset role;

-- 9. HR reads the queue through the view the page uses.
select set_config('request.jwt.claims', json_build_object('sub','a5000000-0000-0000-0000-000000000001','role','int_hr')::text, true);
set role int_hr;
select is(
  (select display_name from api.position_proposals
    where user_id = 'a5000000-0000-0000-0000-000000000002'),
  'New Starter', 'the proposal view resolves the person for the reviewer'
);
select is(
  (select count(*) from api.position_proposals where status = 'pending'),
  0::bigint, 'decided proposals leave the pending queue'
);

select * from finish();
rollback;
