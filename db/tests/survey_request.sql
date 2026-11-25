begin;
set search_path = extensions, public;

select plan(101);

\i db/fixtures/org.sql
delete from survey.survey_request;

-- 1. Setup Test Organizations
insert into party.organization (id, name, org_type, status) values
  ('c0000000-0000-0000-0000-000000000001', 'Acme Shipping Line', 'company', 'active'),
  ('c0000000-0000-0000-0000-000000000002', 'Bravo Tankers Corp', 'company', 'active');

-- 2. Setup Test Fleet
insert into fleet.ship (id, imo_number, name, ship_type, flag_code, gross_tonnage, build_year, status) values
  ('c0000000-0000-0000-0000-000000000010', '9123456', 'MV Acme Pioneer', 'bulk_carrier', 'PA', 35000, 2018, 'in_service'),
  ('c0000000-0000-0000-0000-000000000020', '9654321', 'MV Bravo Voyager', 'oil_tanker', 'LR', 50000, 2021, 'in_service');

-- Affiliations
insert into fleet.ship_party (ship_id, org_id, party_role, valid) values
  ('c0000000-0000-0000-0000-000000000010', 'c0000000-0000-0000-0000-000000000001', 'registered_owner', tstzrange(now() - interval '1 year', null)),
  ('c0000000-0000-0000-0000-000000000020', 'c0000000-0000-0000-0000-000000000002', 'registered_owner', tstzrange(now() - interval '1 year', null));

-- 3. Setup Test Users
insert into iam.app_user (id, kind, display_name, email, status) values
  ('c0000000-0000-0000-0000-000000000031', 'external', 'Alice Acme Requester', 'alice@acme.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000032', 'external', 'Bob Bravo Requester', 'bob@bravo.example.com', 'active');

insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by) values
  ('c0000000-0000-0000-0000-000000000031', 'external', 'c0000000-0000-0000-0000-000000000001', 'requester', '00000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000032', 'external', 'c0000000-0000-0000-0000-000000000002', 'requester', '00000000-0000-0000-0000-000000000001');

-- Internal Users
insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, email, status) values
  ('c0000000-0000-0000-0000-000000000041', 'internal', 'Sam Coord Shanghai', '11111111-1111-1111-1111-111111111111', 'c0000000-1111-1111-1111-111111111111', 'sam.coord@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000042', 'internal', 'Sally Coord Shenzhen', '11111111-1111-1111-1111-111111111111', 'c0000000-2222-2222-2222-222222222222', 'sally.coord@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000043', 'internal', 'Max Mgr Shanghai', '11111111-1111-1111-1111-111111111111', 'c0000000-3333-3333-3333-333333333333', 'max.mgr@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000044', 'internal', 'Carl Area East', '11111111-1111-1111-1111-111111111111', 'c0000000-4444-4444-4444-444444444444', 'carl.area@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000045', 'internal', 'Tim Intern Shanghai', '11111111-1111-1111-1111-111111111111', 'c0000000-5555-5555-5555-555555555555', 'tim.intern@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000046', 'internal', 'Helen Compliance', '11111111-1111-1111-1111-111111111111', 'c0000000-6666-6666-6666-666666666666', 'helen.comp@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000047', 'internal', 'Ned Coord Ningbo', '11111111-1111-1111-1111-111111111111', 'c0000000-7777-7777-7777-777777777777', 'ned.coord@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000048', 'internal', 'Simon Mgr Shenzhen', '11111111-1111-1111-1111-111111111111', 'c0000000-8888-8888-8888-888888888888', 'simon.mgr@mms.example.com', 'active');

-- Positions & Role Assignments
-- Sam: Coordinator @ Shanghai Station (SHA)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000041', 'internal', 'senior_admins', 'office_admin', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000041', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SHA';

-- Sally: Coordinator @ Shenzhen Station (SZX)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000042', 'internal', 'senior_admins', 'office_admin', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SZX';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000042', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SZX';

-- Ned: Coordinator @ Ningbo Station (NGB)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000047', 'internal', 'senior_admins', 'office_admin', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'NGB';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000047', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'NGB';

-- Simon: Manager @ Shenzhen Station (SZX)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000048', 'internal', 'managers', 'management', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SZX';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000048', 'internal', 'int_manager', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SZX';

-- Max: Manager @ Shanghai Station (SHA)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000043', 'internal', 'managers', 'management', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000043', 'internal', 'int_manager', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SHA';

-- Carl: Manager @ East China Regional Office (CN-EAST-RO)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000044', 'internal', 'managers', 'management', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000044', 'internal', 'int_manager', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'CN-EAST-RO';

-- Tim: Intern @ Shanghai Station (SHA, grade 0)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000045', 'internal', 'interns', 'office_admin', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000045', 'internal', 'int_viewer', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'SHA';

-- Helen: Compliance @ HO-COMP (global)
insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000046', 'internal', 'senior_compliance_officers', 'compliance', u.id,
       tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
  from core.org_unit u where u.code = 'HO-COMP';

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
  ('c0000000-0000-0000-0000-000000000046', 'internal', 'int_compliance', 'global', 'manual', '00000000-0000-0000-0000-000000000001', 'fixture');


-- Helper lookup for test station units
create temporary table test_unit_lookup (
  code text primary key,
  id uuid not null
);
insert into test_unit_lookup (code, id)
select code, id from core.org_unit;
grant select on test_unit_lookup to public;

create or replace function _unit(p_code text) returns uuid as $$
  select id from test_unit_lookup where code = p_code;
$$ language sql security definer;
grant execute on function _unit(text) to public;

create temporary table test_ids (
  key text primary key,
  val uuid not null
);
grant all on test_ids to public;

create or replace function _set_test_id(p_key text, p_val uuid) returns uuid as $$
  insert into test_ids (key, val) values (p_key, p_val)
  on conflict (key) do update set val = excluded.val
  returning val;
$$ language sql security definer;

create or replace function _get_test_id(p_key text) returns uuid as $$
  select val from test_ids where key = p_key;
$$ language sql security definer;

grant execute on function _set_test_id(text, uuid) to public;
grant execute on function _get_test_id(text) to public;

create or replace function _audit_count(p_event_type text) returns bigint as $$
  select count(*) from audit_trail.event
   where event_type = p_event_type
     and (
       subject_id in (
         select id from survey.survey_request
          where org_id in ('c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002')
       )
       or subject_id in (
         select id from core.document
          where entity_id in (
            select id from survey.survey_request
             where org_id in ('c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002')
          )
       )
     );
$$ language sql security definer;

create or replace function _audit_last_grade(p_event_type text) returns integer as $$
  select actor_grade from audit_trail.event where event_type = p_event_type order by id desc limit 1;
$$ language sql security definer;

create or replace function _audit_last_title(p_event_type text) returns text as $$
  select actor_title from audit_trail.event where event_type = p_event_type order by id desc limit 1;
$$ language sql security definer;

create or replace function _audit_has_rule(p_event_type text) returns boolean as $$
  select (authority_rule_id is not null) from audit_trail.event where event_type = p_event_type order by id desc limit 1;
$$ language sql security definer;

grant execute on function _audit_count(text) to public;
grant execute on function _audit_last_grade(text) to public;
grant execute on function _audit_last_title(text) to public;
grant execute on function _audit_has_rule(text) to public;

-- Helper macro for setting session context
create or replace function _set_context(p_user_id uuid, p_role text) returns void as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user_id,
    'role', p_role,
    'sid', 'c0000000-0000-0000-0000-000000000099'
  )::text, true);
end;
$$ language plpgsql;

-- 4. Test Schema & Views Structure
select has_table('fleet', 'ship', 'fleet.ship table exists');
select has_table('fleet', 'ship_party', 'fleet.ship_party table exists');
select has_table('survey', 'survey_request', 'survey.survey_request table exists');
select has_table('core', 'document', 'core.document table exists');
select has_table('core', 'document_version', 'core.document_version table exists');
select has_view('api', 'ships', 'api.ships view exists');
select has_view('api', 'survey_requests', 'api.survey_requests view exists');
select has_view('api', 'documents', 'api.documents view exists');
select has_view('api', 'document_versions', 'api.document_versions view exists');

-- 5. Test Fleet & Ship RLS
-- Alice (Org A) can see Ship 1, cannot see Ship 2
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select is(
  (select count(*) from api.ships),
  1::bigint,
  'External user A sees exactly their own ship (Ship 1)'
);

select is(
  (select name from api.ships),
  'MV Acme Pioneer',
  'External user A sees MV Acme Pioneer'
);

-- Staff can see all ships
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select is(
  (select count(*) from api.ships where id in ('c0000000-0000-0000-0000-000000000010', 'c0000000-0000-0000-0000-000000000020')),
  2::bigint,
  'Staff coordinator sees all ships in the registry'
);

-- 6. Test Survey Request Draft Creation
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

-- External user A creates draft for Ship 1 at Shanghai Station
select throws_ok(
  $$ select api.survey_request_create(
       'c0000000-0000-0000-0000-000000000020',
       'c0000000-0000-0000-0000-000000000001',
       _unit('SHA'),
       'Port of Shanghai'
     ) $$,
  '42501',
  null,
  'External user cannot create request for a ship not affiliated with their org'
);

-- Invariant I15: office_unit_id must reference a station
select throws_ok(
  $$ select api.survey_request_create(
       'c0000000-0000-0000-0000-000000000010',
       'c0000000-0000-0000-0000-000000000001',
       _unit('HO'),
       'Port of Shanghai'
     ) $$,
  '23514',
  null,
  'Creating request with non-station unit is rejected (I15)'
);

-- Valid draft creation
select lives_ok(
  $$ select _set_test_id('req1', api.survey_request_create(
       'c0000000-0000-0000-0000-000000000010',
       'c0000000-0000-0000-0000-000000000001',
       _unit('SHA'),
       'Port of Shanghai',
       'CN',
       'CNSHA',
       now() + interval '5 days',
       now() + interval '8 days',
       array['annual_hull', 'annual_machinery'],
       'Annual class survey due'
     )) $$,
  'External user successfully creates draft survey request'
);

-- Verify draft in view
select is(
  (select count(*) from api.survey_requests where ship_name = 'MV Acme Pioneer'),
  1::bigint,
  'External user sees their created draft request'
);

select is(
  (select status from api.survey_requests where ship_name = 'MV Acme Pioneer'),
  'draft',
  'Newly created request is in draft status'
);

select is(
  _audit_count('survey.request.created'),
  1::bigint,
  'survey.request.created event recorded'
);

-- 7. Test Document Attachment
select _set_test_id('doc_ver1', api.document_create_version(
  'survey_request',
  (select id from api.survey_requests where ship_name = 'MV Acme Pioneer'),
  'specification',
  'Survey Scope Specification',
  'spec_v1.pdf',
  'application/pdf',
  1048576,
  decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
  'quarantine/spec_v1.pdf'
));

select is(
  (select count(*) from api.document_versions),
  1::bigint,
  'External user sees attached document version'
);

select is(
  (select sha256 from api.document_versions),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'Document version records server-computed SHA-256'
);

-- External user cannot promote quarantined document version
select throws_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'documents/survey_request/spec_v1.pdf') $$,
  '42501',
  null,
  'External user denied promoting document version'
);

-- Internal viewer cannot promote quarantined document version
reset role;
select _set_context('c0000000-0000-0000-0000-000000000045', 'int_viewer');
set local role int_viewer;
select throws_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'documents/survey_request/spec_v1.pdf') $$,
  '42501',
  null,
  'Internal viewer denied promoting document version'
);

-- Out-of-scope coordinator (SIN) cannot promote SHA document version
reset role;
select _set_context('c0000000-0000-0000-0000-000000000042', 'int_coordinator');
set local role int_coordinator;
select throws_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'documents/survey_request/spec_v1.pdf') $$,
  '42501',
  null,
  'Out-of-scope coordinator denied promoting document version'
);

-- ADR-0023 §8: even an in-scope coordinator cannot promote a version that has
-- never been scanned. This assertion previously asserted the opposite and
-- encoded the defect: "not infected" was treated as "clean".
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;
select throws_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'documents/survey_request/spec_v1.pdf') $$,
  '42501',
  'unscanned_document_cannot_be_promoted',
  'In-scope coordinator denied promoting an unscanned document version'
);

select is(
  (select scan_status from api.document_versions where id = _get_test_id('doc_ver1')),
  'pending',
  'A version created with a non-quarantine path is still pending, not clean'
);

-- The worker records the verdict; only then may the coordinator promote it.
reset role;
select set_config('request.jwt.claims', '', true);
set local role worker;
select lives_ok(
  $$ select private.document_version_record_scan(
       _get_test_id('doc_ver1'), 'clean', 'clamav', null, null, '{}'::jsonb) $$,
  'The worker records a clean verdict for the version'
);

reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;
select lives_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'documents/survey_request/spec_v1.pdf') $$,
  'In-scope coordinator promotes a scanned-clean document version'
);

select is(
  (select storage_path from api.document_versions where id = _get_test_id('doc_ver1')),
  'documents/survey_request/spec_v1.pdf',
  'Document version storage_path is updated to clean path'
);

select throws_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'documents/survey_request/spec_v1.pdf') $$,
  '22023',
  'already_promoted',
  'Promoting already promoted document version throws'
);

-- Promoting with quarantine path throws
select throws_ok(
  $$ select api.document_version_promote(_get_test_id('doc_ver1'), 'quarantine/another.pdf') $$,
  '22023',
  null,
  'Promoting with quarantine path throws'
);

-- External user B cannot attach document to user A request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000032', 'ext_user');
set local role ext_user;

select throws_ok(
  $$ select api.document_create_version(
       'survey_request',
       _get_test_id('req1'),
       'specification',
       'Malicious File',
       'bad.pdf',
       'application/pdf',
       1024,
       decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
       'quarantine/bad.pdf'
     ) $$,
  '42501',
  null,
  'External user from other org denied document attachment'
);

-- 8. Test Submit Transition
-- External user B cannot submit user A request
select throws_ok(
  $$ select api.survey_request_submit(_get_test_id('req1')) $$,
  '42501',
  null,
  'External user B cannot submit Org A survey request'
);

-- Submitting draft with empty survey_types rejected
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select _set_test_id('req_empty_types', api.survey_request_create(
  'c0000000-0000-0000-0000-000000000010',
  'c0000000-0000-0000-0000-000000000001',
  _unit('SHA'),
  'Port of Shanghai',
  'CN',
  'CNSHA',
  now() + interval '5 days',
  now() + interval '8 days',
  array[]::text[],
  'Draft with no survey types'
));

select throws_ok(
  $$ select api.survey_request_submit(_get_test_id('req_empty_types')) $$,
  '22023',
  null,
  'Submitting survey request with empty survey_types is rejected'
);

-- Clean up empty types draft to keep survey_requests view clean
reset role;
delete from survey.survey_request where id = _get_test_id('req_empty_types');

-- Out-of-scope coordinator cannot submit Shanghai request
select _set_context('c0000000-0000-0000-0000-000000000042', 'int_coordinator');
set local role int_coordinator;

select throws_ok(
  $$ select api.survey_request_submit(_get_test_id('req1')) $$,
  '42501',
  null,
  'Out-of-scope coordinator cannot submit Shanghai request'
);

-- Out-of-scope coordinator cannot create request for Shanghai station
select throws_ok(
  $$ select api.survey_request_create(
       'c0000000-0000-0000-0000-000000000010',
       'c0000000-0000-0000-0000-000000000001',
       _unit('SHA'),
       'Port of Shanghai'
     ) $$,
  '42501',
  null,
  'Out-of-scope coordinator cannot create request for Shanghai station'
);

-- Intern cannot submit survey request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000045', 'int_viewer');
set local role int_viewer;

select throws_ok(
  $$ select api.survey_request_submit(_get_test_id('req1')) $$,
  '42501',
  null,
  'Intern cannot submit survey request'
);

-- HO Compliance cannot submit survey request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000046', 'int_compliance');
set local role int_compliance;

select throws_ok(
  $$ select api.survey_request_submit(_get_test_id('req1')) $$,
  '42501',
  null,
  'HO Compliance cannot submit survey request'
);

-- External user A submits
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select lives_ok(
  $$ select api.survey_request_submit(_get_test_id('req1'), 'Submitting for Shanghai triage') $$,
  'External user A successfully submits request'
);

select is(
  (select status from api.survey_requests where id = _get_test_id('req1')),
  'submitted',
  'Survey request status transitioned to submitted'
);

-- Idempotent submit
select lives_ok(
  $$ select api.survey_request_submit(_get_test_id('req1')) $$,
  'Idempotent submit succeeds cleanly'
);

select is(
  _audit_count('survey.request.submitted'),
  1::bigint,
  'Single survey.request.submitted event recorded (idempotent duplicate made no extra event)'
);

-- 9. Test Station Visibility RLS
-- Shanghai coordinator sees request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'Shanghai coordinator sees Shanghai station request'
);

-- Shanghai manager sees request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000043', 'int_manager');
set local role int_manager;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'Shanghai manager sees Shanghai station request'
);

-- East China area manager sees request (covers Shanghai)
reset role;
select _set_context('c0000000-0000-0000-0000-000000000044', 'int_manager');
set local role int_manager;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'East China area manager sees Shanghai station request through regional coverage'
);

-- Shenzhen coordinator does NOT see request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000042', 'int_coordinator');
set local role int_coordinator;

select is(
  (select count(*) from api.survey_requests),
  0::bigint,
  'Shenzhen coordinator cannot see Shanghai station request'
);

-- Shenzhen coordinator cannot see Shanghai documents
select is(
  (select count(*) from api.documents),
  0::bigint,
  'Shenzhen coordinator cannot see Shanghai documents'
);

select is(
  (select count(*) from api.document_versions),
  0::bigint,
  'Shenzhen coordinator cannot see Shanghai document versions'
);

-- Out-of-scope coordinator denied document attachment
select throws_ok(
  $$ select api.document_create_version(
       'survey_request',
       _get_test_id('req1'),
       'specification',
       'Unauthorized Internal Upload',
       'doc.pdf',
       'application/pdf',
       2048,
       decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
       'quarantine/doc.pdf'
     ) $$,
  '42501',
  null,
  'Out-of-scope coordinator denied document attachment'
);

-- Intern denied document attachment
reset role;
select _set_context('c0000000-0000-0000-0000-000000000045', 'int_viewer');
set local role int_viewer;

select throws_ok(
  $$ select api.document_create_version(
       'survey_request',
       _get_test_id('req1'),
       'specification',
       'Intern Upload',
       'doc.pdf',
       'application/pdf',
       2048,
       decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
       'quarantine/doc.pdf'
     ) $$,
  '42501',
  null,
  'Intern denied document attachment'
);

-- HO Compliance denied document attachment
reset role;
select _set_context('c0000000-0000-0000-0000-000000000046', 'int_compliance');
set local role int_compliance;

select throws_ok(
  $$ select api.document_create_version(
       'survey_request',
       _get_test_id('req1'),
       'specification',
       'Compliance Upload',
       'doc.pdf',
       'application/pdf',
       2048,
       decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
       'quarantine/doc.pdf'
     ) $$,
  '42501',
  null,
  'HO Compliance denied document attachment'
);

-- Shenzhen station manager does NOT see Shanghai request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000048', 'int_manager');
set local role int_manager;

select is(
  (select count(*) from api.survey_requests),
  0::bigint,
  'Shenzhen station manager cannot see Shanghai station request'
);

-- HO Compliance sees request (global)
reset role;
select _set_context('c0000000-0000-0000-0000-000000000046', 'int_compliance');
set local role int_compliance;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'HO Compliance sees request worldwide'
);

-- 10. Test Triage - Scope & Authority Denials
-- Shenzhen coordinator attempts to accept Shanghai request -> denied out of scope
reset role;
select _set_context('c0000000-0000-0000-0000-000000000042', 'int_coordinator');
set local role int_coordinator;

select throws_ok(
  $$ select api.survey_request_accept(_get_test_id('req1'), 'Acceptance attempt') $$,
  '42501',
  null,
  'Shenzhen coordinator denied triage on Shanghai request (out of scope)'
);

-- Shanghai intern (grade 0) attempts to accept -> denied insufficient authority
reset role;
select _set_context('c0000000-0000-0000-0000-000000000045', 'int_viewer');
set local role int_viewer;

select throws_ok(
  $$ select api.survey_request_accept(_get_test_id('req1'), 'Acceptance attempt') $$,
  '42501',
  null,
  'Intern denied triage (insufficient authority min_grade 2 required)'
);

-- Compliance attempts triage -> denied (no triage authority rule)
reset role;
select _set_context('c0000000-0000-0000-0000-000000000046', 'int_compliance');
set local role int_compliance;

select throws_ok(
  $$ select api.survey_request_accept(_get_test_id('req1'), 'Compliance attempt') $$,
  '42501',
  null,
  'HO Compliance denied triage action (read-only enforcement)'
);

-- 11. Test Clarification Request Transition
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

-- Missing reason is rejected
select throws_ok(
  $$ select api.survey_request_request_clarification(_get_test_id('req1'), '') $$,
  '22023',
  null,
  'Clarification request requires non-empty reason'
);

-- Valid clarification request
select lives_ok(
  $$ select api.survey_request_request_clarification(
       _get_test_id('req1'),
       'Missing cargo gear certification documents',
       'Please upload the latest cargo gear booklet'
     ) $$,
  'Shanghai coordinator requests clarification'
);

select is(
  (select status from api.survey_requests where id = _get_test_id('req1')),
  'clarification_requested',
  'Survey request status transitioned to clarification_requested'
);

select is(
  _audit_count('survey.request.clarification_requested'),
  1::bigint,
  'survey.request.clarification_requested event emitted'
);

-- Authority evidence captured
select ok(
  _audit_has_rule('survey.request.clarification_requested'),
  'Clarification event captures non-null authority_rule_id'
);

select is(
  _audit_last_grade('survey.request.clarification_requested'),
  3,
  'Clarification event captures coordinator grade 3'
);

-- 12. Test Resubmission
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select lives_ok(
  $$ select api.survey_request_submit(_get_test_id('req1'), 'Uploaded cargo gear booklet') $$,
  'External user successfully resubmits request'
);

select is(
  (select status from api.survey_requests where id = _get_test_id('req1')),
  'submitted',
  'Request back in submitted status'
);

-- 13. Test Station Transfer
-- Create a temporary draft to test transfer rejection on draft status
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select _set_test_id('req_draft', api.survey_request_create(
  'c0000000-0000-0000-0000-000000000010',
  'c0000000-0000-0000-0000-000000000001',
  _unit('SHA'),
  'Port of Shanghai',
  'CN',
  'CNSHA',
  now() + interval '5 days',
  now() + interval '8 days',
  array['annual_hull'],
  'Draft request for transfer test'
));

reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

-- Transfer of draft request rejected
select throws_ok(
  $$ select api.survey_request_transfer(
       _get_test_id('req_draft'),
       _unit('NGB'),
       'Attempting transfer of draft'
     ) $$,
  '22023',
  null,
  'Transfer of draft survey request is rejected'
);

-- Clean up draft
reset role;
delete from survey.survey_request where id = _get_test_id('req_draft');

select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

-- Target must be a station
select throws_ok(
  $$ select api.survey_request_transfer(
       _get_test_id('req1'),
       _unit('CN-EAST-RO'),
       'Transfer to regional office'
     ) $$,
  '23514',
  null,
  'Transfer to non-station unit rejected'
);

-- Transfer to Ningbo Station (NGB)
select lives_ok(
  $$ select api.survey_request_transfer(
       _get_test_id('req1'),
       _unit('NGB'),
       'Vessel diverted to Ningbo port due to berth congestion'
     ) $$,
  'Shanghai coordinator transfers request to Ningbo Station'
);

select is(
  _audit_count('survey.request.transferred'),
  1::bigint,
  'survey.request.transferred event emitted'
);

-- Now Shanghai coordinator no longer sees the request
select is(
  (select count(*) from api.survey_requests),
  0::bigint,
  'Shanghai coordinator no longer sees transferred request'
);

-- But East China regional manager still sees it
reset role;
select _set_context('c0000000-0000-0000-0000-000000000044', 'int_manager');
set local role int_manager;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'East China area manager still sees transferred request at Ningbo'
);

-- 14. Transfer Back by Ningbo Coordinator
reset role;
select _set_context('c0000000-0000-0000-0000-000000000047', 'int_coordinator');
set local role int_coordinator;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'Ningbo coordinator sees transferred request'
);

select lives_ok(
  $$ select api.survey_request_transfer(
       _get_test_id('req1'),
       _unit('SHA'),
       'Berth cleared at Shanghai; vessel returning to original port of call'
     ) $$,
  'Ningbo coordinator transfers request back to Shanghai Station'
);

select is(
  _audit_count('survey.request.transferred'),
  2::bigint,
  'Second survey.request.transferred event emitted'
);

-- Ningbo coordinator no longer sees it
select is(
  (select count(*) from api.survey_requests),
  0::bigint,
  'Ningbo coordinator no longer sees re-transferred request'
);

-- Shanghai coordinator sees it again
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select is(
  (select count(*) from api.survey_requests),
  1::bigint,
  'Shanghai coordinator sees re-transferred request'
);

-- 15. Test Acceptance Transition
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select lives_ok(
  $$ select api.survey_request_accept(
       _get_test_id('req1'),
       'All scope requirements verified, surveyor assigned',
       'Assigned to Team Alpha for attendance'
     ) $$,
  'Shanghai coordinator accepts survey request'
);

select is(
  (select status from api.survey_requests where id = _get_test_id('req1')),
  'accepted',
  'Survey request status transitioned to accepted'
);

select is(
  _audit_count('survey.request.accepted'),
  1::bigint,
  'survey.request.accepted event emitted'
);

-- Authority snapshot verified on acceptance
select ok(
  _audit_has_rule('survey.request.accepted'),
  'Accept event captures non-null authority_rule_id'
);

select is(
  _audit_last_title('survey.request.accepted'),
  'senior_admins',
  'Accept event captures senior_admins job title'
);

-- 16. Test Rejection Transition on a Second Request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select lives_ok(
  $$ select api.survey_request_create(
       'c0000000-0000-0000-0000-000000000010',
       'c0000000-0000-0000-0000-000000000001',
       _unit('SHA'),
       'Port of Shanghai',
       'CN',
       'CNSHA',
       now() + interval '10 days',
       now() + interval '12 days',
       array['damage_survey'],
       'Collision damage inspection'
     ) $$,
  'External user creates second survey request'
);

select lives_ok(
  $$ select api.survey_request_submit(
       (select id from api.survey_requests where scope_description = 'Collision damage inspection'),
       'Urgent damage survey submission'
     ) $$,
  'External user submits second survey request'
);

-- Shanghai coordinator rejects second request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select lives_ok(
  $$ select api.survey_request_reject(
       (select id from api.survey_requests where scope_description = 'Collision damage inspection'),
       'Class suspension active; damage surveys require special authorization',
       'Vessel must regularize overdue condition of class first'
     ) $$,
  'Coordinator rejects second survey request with mandatory reason'
);

select is(
  (select status from api.survey_requests where scope_description = 'Collision damage inspection'),
  'rejected',
  'Second survey request status transitioned to rejected'
);

select is(
  _audit_count('survey.request.rejected'),
  1::bigint,
  'survey.request.rejected event emitted'
);

-- Cannot attach document to rejected request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select throws_ok(
  $$ select api.document_create_version(
       'survey_request',
       (select id from api.survey_requests where scope_description = 'Collision damage inspection'),
       'specification',
       'Post-rejection upload',
       'doc.pdf',
       'application/pdf',
       2048,
       decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
       'quarantine/doc.pdf'
     ) $$,
  '22023',
  null,
  'Document attachment on rejected survey request is rejected'
);

-- Cannot transfer rejected request
reset role;
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select throws_ok(
  $$ select api.survey_request_transfer(
       (select id from api.survey_requests where scope_description = 'Collision damage inspection'),
       _unit('NGB'),
       'Attempting transfer of rejected request'
     ) $$,
  '22023',
  null,
  'Transfer of rejected survey request is rejected'
);

-- 17. Test Audit Completeness & Atomicity
-- Change log and event share identical tx_id across all transitions
reset role;
select is(
  (select e.tx_id
     from audit_trail.event e
    where e.event_type = 'survey.request.created'
      and e.subject_id = _get_test_id('req1')),
  (select c.tx_id
     from audit_trail.change_log c
    where c.table_name = 'survey_request'
      and c.row_id = _get_test_id('req1')
      and c.op = 'I'),
  'Creation event and survey_request change_log share identical tx_id'
);

select is(
  (select e.tx_id
     from audit_trail.event e
    where e.event_type = 'survey.request.submitted'
      and e.subject_id = _get_test_id('req1')
    order by e.id asc limit 1),
  (select c.tx_id
     from audit_trail.change_log c
    where c.table_name = 'survey_request'
      and c.row_id = _get_test_id('req1')
      and c.op = 'U'
      and c.new_row ->> 'status' = 'submitted'
    order by c.id asc limit 1),
  'Submission event and survey_request change_log share identical tx_id'
);

select is(
  (select e.tx_id
     from audit_trail.event e
    where e.event_type = 'survey.request.accepted'
    order by e.id desc limit 1),
  (select c.tx_id
     from audit_trail.change_log c
    where c.table_name = 'survey_request'
      and c.new_row ->> 'status' = 'accepted'
    order by c.id desc limit 1),
  'Acceptance event and survey_request change_log share identical tx_id'
);

select is(
  (select e.tx_id
     from audit_trail.event e
    where e.event_type = 'survey.request.rejected'
    order by e.id desc limit 1),
  (select c.tx_id
     from audit_trail.change_log c
    where c.table_name = 'survey_request'
      and c.new_row ->> 'status' = 'rejected'
    order by c.id desc limit 1),
  'Rejection event and survey_request change_log share identical tx_id'
);

-- 18. Test External User Active Station Read
reset role;
select _set_context('c0000000-0000-0000-0000-000000000031', 'ext_user');
set local role ext_user;

select is(
  (select count(*) from api.org_units),
  (select count(*) from core.org_unit where unit_type = 'station' and active),
  'External user sees exactly active station org units'
);

select is(
  (select count(*) from api.org_units where unit_type <> 'station'),
  0::bigint,
  'External user sees zero non-station org units (no HO, regional, or MTS units visible)'
);

-- 19. Additional Completeness on Transfer and Clarification Transitions
reset role;
select is(
  (select e.tx_id
     from audit_trail.event e
    where e.event_type = 'survey.request.transferred'
    order by e.id desc limit 1),
  (select c.tx_id
     from audit_trail.change_log c
    where c.table_name = 'survey_request'
      and c.changed_cols @> array['office_unit_id']
    order by c.id desc limit 1),
  'Transfer event and survey_request change_log share identical tx_id'
);

select is(
  (select e.tx_id
     from audit_trail.event e
    where e.event_type = 'survey.request.clarification_requested'
    order by e.id desc limit 1),
  (select c.tx_id
     from audit_trail.change_log c
    where c.table_name = 'survey_request'
      and c.new_row ->> 'status' = 'clarification_requested'
    order by c.id desc limit 1),
  'Clarification event and survey_request change_log share identical tx_id'
);

-- 20. Reconstructability of Full Operational History from audit_trail.*
select ok(
  exists (
    select 1 from audit_trail.event e
     where e.event_type = 'survey.request.accepted'
       and e.actor_id = 'c0000000-0000-0000-0000-000000000041'
       and e.actor_title = 'senior_admins'
       and e.actor_grade = 3
       and e.actor_unit_id = _unit('SHA')
       and e.reason is not null
  ),
  'Full triage history reconstructable: who triaged, title senior_admins, grade 3, station SHA, reason captured'
);

select ok(
  exists (
    select 1 from audit_trail.event e
     where e.event_type = 'survey.request.transferred'
       and e.actor_id = 'c0000000-0000-0000-0000-000000000041'
       and e.actor_title = 'senior_admins'
       and e.actor_grade = 3
       and e.actor_unit_id = _unit('SHA')
       and e.scope_unit_id = _unit('NGB')
       and e.reason = 'Vessel diverted to Ningbo port due to berth congestion'
  ),
  'Full transfer history reconstructable: who transferred, title senior_admins, grade 3, source station SHA, target station NGB, reason captured'
);

select ok(
  exists (
    select 1 from audit_trail.event e
     where e.event_type = 'survey.request.clarification_requested'
       and e.actor_id = 'c0000000-0000-0000-0000-000000000041'
       and e.actor_title = 'senior_admins'
       and e.actor_grade = 3
       and e.actor_unit_id = _unit('SHA')
       and e.reason = 'Missing cargo gear certification documents'
  ),
  'Full clarification history reconstructable: who clarified, title senior_admins, grade 3, station SHA, reason captured'
);

select ok(
  exists (
    select 1 from audit_trail.event e
     where e.event_type = 'survey.request.rejected'
       and e.actor_id = 'c0000000-0000-0000-0000-000000000041'
       and e.actor_title = 'senior_admins'
       and e.actor_grade = 3
       and e.actor_unit_id = _unit('SHA')
       and e.reason = 'Class suspension active; damage surveys require special authorization'
  ),
  'Full rejection history reconstructable: who rejected, title senior_admins, grade 3, station SHA, reason captured'
);

-- 21. Survey Transition Rollback Atomicity
savepoint sp_survey_atomicity;
do $$
begin
  perform private.emit_event(
    'survey.request.accepted', 'success', 'survey_request',
    _get_test_id('req1'), _unit('SHA'), 'Atomicity probe',
    '{"atomicity_test": true}'::jsonb
  );
  raise exception 'forced_survey_transition_failure';
exception when others then
  null; -- caught
end;
$$;
rollback to savepoint sp_survey_atomicity;

select is(
  (select count(*) from audit_trail.event where detail ->> 'atomicity_test' = 'true'),
  0::bigint,
  'Forced survey transition failure leaves no event behind (atomicity by rollback)'
);

-- Verify rolled-back out-of-scope triage attempt left no lingering event
select is(
  (select count(*) from audit_trail.event where event_type = 'authz.denied.out_of_scope' and detail ->> 'role' = 'int_coordinator'),
  0::bigint,
  'Rolled back out-of-scope triage attempt left no lingering event'
);

-- 22. Direct UPDATE on controlled columns denied by RLS
select _set_context('c0000000-0000-0000-0000-000000000041', 'int_coordinator');
set local role int_coordinator;

select throws_ok(
  $$ update survey.survey_request set status = 'accepted' where id = 'c0000000-0000-0000-0000-000000000010' $$,
  '42501',
  null,
  'Direct UPDATE on survey.survey_request denied to capability roles'
);

select * from finish();
rollback;
