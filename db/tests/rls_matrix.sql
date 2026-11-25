begin;
set search_path = extensions, public;

select plan(144);

\i db/fixtures/org.sql

-- 1. Structural checks
select has_table('party', 'organization', 'party.organization exists');
select has_view('api', 'organizations', 'api.organizations view exists');
select has_view('api', 'user_directory', 'api.user_directory view exists');
select has_view('api', 'staff_positions', 'api.staff_positions view exists');

-- 2. Load CSV matrix into temporary table
create temp table test_matrix (
  id integer generated always as identity primary key,
  role text not null,
  scope_type text not null,
  object text not null,
  operation text not null,
  expected text not null
);

\copy test_matrix (role, scope_type, object, operation, expected) from 'db/tests/rls_matrix.csv' with (format csv, header);

select is((select count(*) from test_matrix), 79::bigint, 'RLS matrix CSV loaded with 79 rules');

-- 3. Setup test principals and fixtures
insert into party.organization (id, name, org_type, status) values
  ('99999999-9999-9999-9999-999999999991', 'Acme Shipping', 'company', 'active'),
  ('99999999-9999-9999-9999-999999999992', 'Global Maritime', 'company', 'active');

insert into iam.app_user (id, kind, display_name, email, status) values
  ('c0000000-0000-0000-0000-000000000001', 'external', 'Carol Acme', 'carol@acme.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000002', 'external', 'Dave Global', 'dave@global.example.com', 'active');

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, email, status) values
  ('c0000000-0000-0000-0000-000000000003', 'internal', 'Alice HR', '11111111-1111-1111-1111-111111111111', 'c0000000-1111-1111-1111-111111111111', 'alice@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000004', 'internal', 'Bob Manager', '11111111-1111-1111-1111-111111111111', 'c0000000-2222-2222-2222-222222222222', 'bob@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000005', 'internal', 'Grace Surveyor', '11111111-1111-1111-1111-111111111111', 'c0000000-3333-3333-3333-333333333333', 'grace@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000006', 'internal', 'Ivan Ningbo', '11111111-1111-1111-1111-111111111111', 'c0000000-4444-4444-4444-444444444444', 'ivan@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000007', 'internal', 'Henry Coordinator', '11111111-1111-1111-1111-111111111111', 'c0000000-5555-5555-5555-555555555555', 'henry@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000008', 'internal', 'Helen Compliance', '11111111-1111-1111-1111-111111111111', 'c0000000-6666-6666-6666-666666666666', 'helen@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-000000000009', 'internal', 'George Sysadmin', '11111111-1111-1111-1111-111111111111', 'c0000000-7777-7777-7777-777777777777', 'george@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-00000000000a', 'internal', 'Kevin Viewer', '11111111-1111-1111-1111-111111111111', 'c0000000-8888-8888-8888-888888888888', 'kevin@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-00000000000b', 'internal', 'Wendy Multi', '11111111-1111-1111-1111-111111111111', 'c0000000-9999-9999-9999-999999999999', 'wendy@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-00000000000c', 'internal', 'Frank AreaMgr', '11111111-1111-1111-1111-111111111111', 'c0000000-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'frank@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-00000000000d', 'internal', 'Paul Plan', '11111111-1111-1111-1111-111111111111', 'c0000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'paul@mms.example.com', 'active'),
  ('c0000000-0000-0000-0000-00000000000f', 'internal', 'Fiona Finance', '11111111-1111-1111-1111-111111111111', 'c0000000-ffff-ffff-ffff-ffffffffffff', 'fiona@mms.example.com', 'active');

insert into iam.org_membership (id, user_id, org_id, member_role, granted_by, valid) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', 'requester', 'c0000000-0000-0000-0000-000000000003', tstzrange(now()-interval '1 day', null)),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', '99999999-9999-9999-9999-999999999992', 'requester', 'c0000000-0000-0000-0000-000000000003', tstzrange(now()-interval '1 day', null)),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999992', 'viewer', 'c0000000-0000-0000-0000-000000000003', tstzrange(now()-interval '10 days', now()-interval '1 hour'));

-- Positions:
insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000003', 'hr_directors', 'hr', u.id, null, tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000004', 'init'
  from core.org_unit u where u.code = 'HO';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-00000000000c', 'senior_managers', 'management', u.id, null, tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000004', 'managers', 'management', u.id, 'c0000000-0000-0000-0000-00000000000c', tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000005', 'senior_surveyors', 'survey', u.id, 'c0000000-0000-0000-0000-000000000004', tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000006', 'surveyors', 'survey', u.id, 'c0000000-0000-0000-0000-00000000000c', tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'NGB';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000007', 'admins', 'office_admin', u.id, 'c0000000-0000-0000-0000-000000000004', tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-000000000008', 'senior_compliance_officers', 'compliance', u.id, null, tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'HO-COMP';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-00000000000a', 'interns', 'survey', u.id, 'c0000000-0000-0000-0000-000000000004', tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-00000000000d', 'engineers', 'office_admin', u.id, null, tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'PA-SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'c0000000-0000-0000-0000-00000000000f', 'senior_finance', 'finance', u.id, null, tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'HO';

-- Role assignments:
insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason) values
  ('c0000000-0000-0000-0000-000000000003', 'int_hr', 'global', null, 'manual', 'c0000000-0000-0000-0000-000000000004', 'init'),
  ('c0000000-0000-0000-0000-000000000008', 'int_compliance', 'global', null, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'),
  ('c0000000-0000-0000-0000-000000000009', 'int_sysadmin', 'global', null, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'),
  ('c0000000-0000-0000-0000-00000000000f', 'int_finance', 'global', null, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init');

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000004', 'int_manager', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-00000000000c', 'int_manager', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000005', 'int_surveyor', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000006', 'int_surveyor', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'NGB';

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000007', 'int_coordinator', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-00000000000a', 'int_viewer', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';

insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-00000000000d', 'int_viewer', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'PA-SHA';

-- Wendy holds surveyor at SHA AND coordinator at NGB (multi-role testing):
insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-00000000000b', 'int_surveyor', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'SHA';
insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-00000000000b', 'int_coordinator', 'unit', u.id, 'manual', 'c0000000-0000-0000-0000-000000000003', 'init'
  from core.org_unit u where u.code = 'NGB';

-- Grace also has an expired auditor assignment at SHA:
insert into iam.role_assignment (user_id, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
select 'c0000000-0000-0000-0000-000000000005', 'int_auditor', 'unit', u.id, 'manual', tstzrange(now()-interval '10 days', now()-interval '1 hour'), 'c0000000-0000-0000-0000-000000000003', 'expired'
  from core.org_unit u where u.code = 'SHA';

-- Coverage: Shanghai covers Hangzhou (active), and covers Guangzhou (expired)
insert into core.org_unit_coverage (unit_id, covered_unit_id, valid, set_by, reason)
select sha.id, hgh.id, tstzrange(now()-interval '1 day', null), 'c0000000-0000-0000-0000-000000000009', 'active coverage'
  from core.org_unit sha, core.org_unit hgh
 where sha.code = 'SHA' and hgh.code = 'HGH';

insert into core.org_unit_coverage (unit_id, covered_unit_id, valid, set_by, reason)
select sha.id, can.id, tstzrange(now()-interval '10 days', now()-interval '1 hour'), 'c0000000-0000-0000-0000-000000000009', 'expired coverage'
  from core.org_unit sha, core.org_unit can
 where sha.code = 'SHA' and can.code = 'CAN';

create function party.test_is_station(p_unit_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from core.org_unit u where u.id = p_unit_id and u.unit_type = 'station');
$$;

create function party.test_is_routed_or_mts(p_unit_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from core.org_unit u where u.id = p_unit_id and u.unit_type in ('plan_approval_centre', 'mts_centre'));
$$;

-- 4. Temporary location-scoped and routed tables to test scoping invariants (I15, T9, WITH CHECK)
create table party.test_location_job (
  id uuid primary key default uuidv7(),
  office_unit_id uuid not null references core.org_unit(id),
  title text not null,
  constraint test_location_job_station_fk check (party.test_is_station(office_unit_id))
);
alter table party.test_location_job enable row level security;

create policy test_location_job_select on party.test_location_job
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager, int_compliance
  using (office_unit_id = any (private.my_offices()));

create policy test_location_job_insert on party.test_location_job
  for insert to int_surveyor, int_manager
  with check (office_unit_id = any (private.my_offices()));

create policy test_location_job_update on party.test_location_job
  for update to int_surveyor, int_manager
  using (office_unit_id = any (private.my_offices()))
  with check (office_unit_id = any (private.my_offices()));

grant select on party.test_location_job to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager, int_compliance;
grant insert, update on party.test_location_job to int_surveyor, int_manager;

create table party.test_routed_case (
  id uuid primary key default uuidv7(),
  handling_unit_id uuid not null references core.org_unit(id),
  title text not null,
  constraint test_routed_case_centre_fk check (party.test_is_routed_or_mts(handling_unit_id))
);
alter table party.test_routed_case enable row level security;

create policy test_routed_case_select on party.test_routed_case
  for select to int_viewer, int_manager, int_compliance
  using (handling_unit_id = any (private.my_units()));

create policy test_routed_case_insert on party.test_routed_case
  for insert to int_manager
  with check (handling_unit_id = any (private.my_units()));

create policy test_routed_case_update on party.test_routed_case
  for update to int_manager
  using (handling_unit_id = any (private.my_units()))
  with check (handling_unit_id = any (private.my_units()));

grant select on party.test_routed_case to int_viewer, int_manager, int_compliance;
grant insert, update on party.test_routed_case to int_manager;

-- Insert seed test records
insert into party.test_location_job (id, office_unit_id, title) values
  ('e0000000-0000-0000-0000-000000000001', (select id from core.org_unit where code = 'SHA'), 'Shanghai Job 1'),
  ('e0000000-0000-0000-0000-000000000002', (select id from core.org_unit where code = 'NGB'), 'Ningbo Job 1'),
  ('e0000000-0000-0000-0000-000000000003', (select id from core.org_unit where code = 'HGH'), 'Hangzhou Job 1'),
  ('e0000000-0000-0000-0000-000000000004', (select id from core.org_unit where code = 'CAN'), 'Guangzhou Job 1');

insert into party.test_routed_case (id, handling_unit_id, title) values
  ('f0000000-0000-0000-0000-000000000001', (select id from core.org_unit where code = 'PA-SHA'), 'PA Shanghai Case 1'),
  ('f0000000-0000-0000-0000-000000000002', (select id from core.org_unit where code = 'PA-CAN'), 'PA Guangzhou Case 1');

-- Transfer function for T9 demonstration
create function private.test_transfer_location_job(p_job_id uuid, p_target_office uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.active_role() not in ('int_manager', 'int_coordinator') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  if not exists (select 1 from party.test_location_job where id = p_job_id and office_unit_id = any (private.my_offices())) then
    raise exception 'out_of_scope' using errcode = '42501';
  end if;
  update party.test_location_job set office_unit_id = p_target_office where id = p_job_id;
end;
$$;
revoke all on function private.test_transfer_location_job(uuid, uuid) from public;
grant execute on function private.test_transfer_location_job(uuid, uuid) to int_manager, int_coordinator;


-- =========================================================================
-- Matrix Evaluator Function: dynamically evaluates rules from rls_matrix.csv
-- =========================================================================
create function party.test_eval_matrix_rule(
  p_role text,
  p_scope_type text,
  p_object text,
  p_operation text
) returns text
language plpgsql
security invoker
as $$
declare
  v_uid uuid;
  v_role text := p_role;
  v_cnt bigint;
  v_grade int;
  v_mgr uuid;
  v_sha_id uuid;
  v_ngb_id uuid;
  v_hgh_id uuid;
  v_can_id uuid;
  v_acme_id uuid := '99999999-9999-9999-9999-999999999991'::uuid;
  v_global_id uuid := '99999999-9999-9999-9999-999999999992'::uuid;
  v_sha_job_id uuid := 'e0000000-0000-0000-0000-000000000001'::uuid;
  v_ngb_job_id uuid := 'e0000000-0000-0000-0000-000000000002'::uuid;
begin
  select id into v_sha_id from core.org_unit where code = 'SHA';
  select id into v_ngb_id from core.org_unit where code = 'NGB';
  select id into v_hgh_id from core.org_unit where code = 'HGH';
  select id into v_can_id from core.org_unit where code = 'CAN';

  -- Map test principal and role
  case p_role
    when 'ext_user' then
      v_uid := 'c0000000-0000-0000-0000-000000000001';
      v_role := 'ext_user';
    when 'web_anon' then
      v_uid := null;
      v_role := 'web_anon';
    when 'int_viewer' then
      v_uid := 'c0000000-0000-0000-0000-00000000000a';
      v_role := 'int_viewer';
    when 'int_surveyor' then
      v_uid := 'c0000000-0000-0000-0000-000000000005';
      v_role := 'int_surveyor';
    when 'int_coordinator' then
      v_uid := 'c0000000-0000-0000-0000-000000000007';
      v_role := 'int_coordinator';
    when 'int_manager' then
      if p_scope_type = 'parent_unit' then
        v_uid := 'c0000000-0000-0000-0000-00000000000c'; -- Frank AreaMgr
      else
        v_uid := 'c0000000-0000-0000-0000-000000000004'; -- Bob StationMgr
      end if;
      v_role := 'int_manager';
    when 'int_compliance' then
      v_uid := 'c0000000-0000-0000-0000-000000000008';
      v_role := 'int_compliance';
    when 'int_hr' then
      v_uid := 'c0000000-0000-0000-0000-000000000003';
      v_role := 'int_hr';
    when 'int_finance' then
      v_uid := 'c0000000-0000-0000-0000-00000000000f';
      v_role := 'int_finance';
    when 'int_sysadmin' then
      v_uid := 'c0000000-0000-0000-0000-000000000009';
      v_role := 'int_sysadmin';
    when 'any_staff' then
      if p_scope_type = 'expired_scope' and p_object = 'routed_record' then
        v_uid := 'c0000000-0000-0000-0000-00000000000d'; -- Paul Plan
        v_role := 'int_viewer';
      else
        v_uid := 'c0000000-0000-0000-0000-000000000005'; -- Grace Surveyor
        v_role := 'int_surveyor';
      end if;
    when 'multi_role' then
      v_uid := 'c0000000-0000-0000-0000-00000000000b'; -- Wendy Multi
      v_role := 'int_surveyor';
    else
      v_uid := null;
      v_role := p_role;
  end case;

  -- Activate session role and claims
  execute format('set local role %I', v_role);
  if v_uid is not null then
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid::text, 'role', v_role)::text, true);
  else
    perform set_config('request.jwt.claims', '', true);
  end if;

  -- Execute operation
  begin
    if p_object = 'organization' then
      if p_operation = 'select' then
        if p_scope_type = 'own_org' then
          select count(*) into v_cnt from api.organizations where id = v_acme_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        elsif p_scope_type = 'foreign_org' then
          select count(*) into v_cnt from api.organizations where id = v_global_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        else
          select count(*) into v_cnt from api.organizations;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        end if;
      elsif p_operation = 'id_guess' then
        select count(*) into v_cnt from party.organization where id = v_global_id;
        execute 'reset role';
        return case when v_cnt > 0 then 'allow' else 'deny' end;
      elsif p_operation = 'insert' then
        insert into party.organization (name, org_type) values ('Evil Corp', 'company');
        execute 'reset role';
        return 'allow';
      elsif p_operation = 'update' then
        update party.organization set name = 'Hacked Acme' where id = v_acme_id;
        execute 'reset role';
        return 'allow';
      end if;

    elsif p_object = 'user_directory' then
      if p_operation = 'select' then
        select count(*) into v_cnt from api.user_directory;
        execute 'reset role';
        return case when v_cnt > 0 then 'allow' else 'deny' end;
      end if;

    elsif p_object = 'staff_position' then
      if p_operation = 'select' then
        select count(*) into v_cnt from api.staff_positions;
        execute 'reset role';
        return case when v_cnt > 0 then 'allow' else 'deny' end;
      end if;

    elsif p_object = 'location_record' then
      if p_operation = 'select' then
        if p_scope_type = 'own_unit' then
          select count(*) into v_cnt from party.test_location_job where office_unit_id = v_sha_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        elsif p_scope_type = 'foreign_unit' then
          select count(*) into v_cnt from party.test_location_job where office_unit_id = v_ngb_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        elsif p_scope_type = 'parent_unit' then
          select count(*) into v_cnt from party.test_location_job where office_unit_id in (v_sha_id, v_ngb_id);
          execute 'reset role';
          return case when v_cnt >= 2 then 'allow' else 'deny' end;
        elsif p_scope_type = 'global' then
          select count(*) into v_cnt from party.test_location_job;
          execute 'reset role';
          return case when v_cnt >= 2 then 'allow' else 'deny' end;
        elsif p_scope_type = 'expired_scope' then
          execute 'set local role int_auditor';
          perform set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_auditor')::text, true);
          select count(*) into v_cnt from party.test_location_job;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        elsif p_scope_type = 'covered_unit' then
          select count(*) into v_cnt from party.test_location_job where office_unit_id = v_hgh_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        elsif p_scope_type = 'expired_coverage' then
          select count(*) into v_cnt from party.test_location_job where office_unit_id = v_can_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        elsif p_scope_type = 'inactive_role' then
          select count(*) into v_cnt from party.test_location_job where office_unit_id = v_ngb_id;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        else
          select count(*) into v_cnt from party.test_location_job;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        end if;
      elsif p_operation = 'id_guess' then
        select count(*) into v_cnt from party.test_location_job where id = v_ngb_job_id;
        execute 'reset role';
        return case when v_cnt > 0 then 'allow' else 'deny' end;
      elsif p_operation = 'insert' then
        if p_scope_type = 'own_unit' then
          insert into party.test_location_job (office_unit_id, title) values (v_sha_id, 'Matrix Insert Job');
          execute 'reset role';
          return 'allow';
        elsif p_scope_type = 'foreign_unit' then
          insert into party.test_location_job (office_unit_id, title) values (v_ngb_id, 'Matrix Bad Job');
          execute 'reset role';
          return 'allow';
        else
          insert into party.test_location_job (office_unit_id, title) values (v_sha_id, 'Matrix Job');
          execute 'reset role';
          return 'allow';
        end if;
      elsif p_operation = 'update' then
        update party.test_location_job set title = 'Updated Title' where id = v_sha_job_id;
        execute 'reset role';
        return 'allow';
      elsif p_operation = 'scope_tamper' then
        update party.test_location_job set office_unit_id = v_ngb_id where id = v_sha_job_id;
        execute 'reset role';
        return 'allow';
      end if;

    elsif p_object = 'routed_record' then
      if p_operation = 'select' then
        if p_scope_type = 'expired_scope' then
          execute 'set local role int_viewer';
          perform set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000a', 'role', 'int_viewer')::text, true);
          select count(*) into v_cnt from party.test_routed_case;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        else
          select count(*) into v_cnt from party.test_routed_case;
          execute 'reset role';
          return case when v_cnt > 0 then 'allow' else 'deny' end;
        end if;
      end if;

    elsif p_object = 'grade_field' then
      if p_operation = 'select' then
        if p_role = 'int_hr' then
          select grade into v_grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005';
          execute 'reset role';
          return case when v_grade is not null then 'allow' else 'deny' end;
        elsif p_role = 'int_manager' then
          if p_scope_type = 'own_unit' then
            select grade into v_grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005';
            execute 'reset role';
            return case when v_grade is not null then 'allow' else 'deny' end;
          else
            select grade into v_grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000003';
            execute 'reset role';
            return case when v_grade is not null then 'allow' else 'deny' end;
          end if;
        else
          select grade into v_grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000004';
          execute 'reset role';
          return case when v_grade is not null then 'allow' else 'deny' end;
        end if;
      end if;

    elsif p_object = 'line_manager_field' then
      if p_operation = 'select' then
        if p_role = 'int_hr' then
          select line_manager_id into v_mgr from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005';
          execute 'reset role';
          return case when v_mgr is not null then 'allow' else 'deny' end;
        elsif p_role = 'int_manager' then
          if p_scope_type = 'own_unit' then
            select line_manager_id into v_mgr from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005';
            execute 'reset role';
            return case when v_mgr is not null then 'allow' else 'deny' end;
          else
            select line_manager_id into v_mgr from api.user_directory where id = 'c0000000-0000-0000-0000-000000000006';
            execute 'reset role';
            return case when v_mgr is not null then 'allow' else 'deny' end;
          end if;
        else
          select line_manager_id into v_mgr from api.user_directory where id = 'c0000000-0000-0000-0000-000000000004';
          execute 'reset role';
          return case when v_mgr is not null then 'allow' else 'deny' end;
        end if;
      end if;

    elsif p_object = 'org_membership' then
      if p_operation = 'select' then
        select count(*) into v_cnt from iam.org_membership;
        execute 'reset role';
        return case when v_cnt > 0 then 'allow' else 'deny' end;
      end if;
    end if;

    execute 'reset role';
    return 'deny';
  exception when others then
    execute 'reset role';
    return 'deny';
  end;
end;
$$;


-- =========================================================================
-- RUN CSV MATRIX TEST: Execute every single rule from rls_matrix.csv
-- =========================================================================
select ok(
  party.test_eval_matrix_rule(role, scope_type, object, operation) = expected,
  'Matrix CSV rule #' || id || ': ' || role || ' | ' || scope_type || ' | ' || object || ' | ' || operation || ' -> ' || expected
) from test_matrix order by id;


-- =========================================================================
-- AC: ID Guessing Fails (IDOR)
-- =========================================================================

-- Carol (ext_user in Acme) guessing Dave's org ID (Global Maritime)
set local role ext_user;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'ext_user')::text, true);

select is((select count(*) from party.organization where id = '99999999-9999-9999-9999-999999999992'), 0::bigint,
          'ID guessing: external user querying foreign org in party.organization returns 0 rows');

select is((select count(*) from api.organizations where id = '99999999-9999-9999-9999-999999999992'), 0::bigint,
          'ID guessing: external user querying foreign org in api.organizations returns 0 rows');

select is((select count(*) from api.organizations where id = '99999999-9999-9999-9999-999999999991'), 1::bigint,
          'external user can select own org in api.organizations');
reset role;

-- Grace (SHA surveyor) guessing Ningbo location job ID
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_surveyor')::text, true);

select is((select count(*) from party.test_location_job where id = 'e0000000-0000-0000-0000-000000000002'), 0::bigint,
          'ID guessing: station surveyor querying foreign station job returns 0 rows');

select is((select count(*) from party.test_location_job where id = 'e0000000-0000-0000-0000-000000000001'), 1::bigint,
          'station surveyor sees own station job');
reset role;

-- Bob (SHA station manager) guessing Ningbo job ID
set local role int_manager;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000004', 'role', 'int_manager')::text, true);

select is((select count(*) from party.test_location_job where id = 'e0000000-0000-0000-0000-000000000002'), 0::bigint,
          'ID guessing: station manager querying foreign station job returns 0 rows');

select is((select count(*) from party.test_location_job where id = 'e0000000-0000-0000-0000-000000000001'), 1::bigint,
          'station manager sees own station job');
reset role;

-- Paul (PA-SHA viewer/engineer) guessing PA-CAN routed case ID
set local role int_viewer;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000d', 'role', 'int_viewer')::text, true);

select is((select count(*) from party.test_routed_case where id = 'f0000000-0000-0000-0000-000000000002'), 0::bigint,
          'ID guessing: routed unit user querying foreign routed case returns 0 rows');

select is((select count(*) from party.test_routed_case where id = 'f0000000-0000-0000-0000-000000000001'), 1::bigint,
          'routed unit user sees own routed case');
reset role;


-- =========================================================================
-- AC: WITH CHECK Blocks Changes to org_id, office_unit_id, handling_unit_id
-- =========================================================================

-- External user cannot insert or update organization
set local role ext_user;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'ext_user')::text, true);
select throws_ok(
  $$insert into party.organization (name, org_type) values ('Hacked Org', 'company')$$,
  '42501', null, 'external user cannot insert organization'
);
select throws_ok(
  $$update party.organization set name = 'Hacked Acme' where id = '99999999-9999-9999-9999-999999999991'$$,
  '42501', null, 'external user cannot update organization'
);
reset role;

-- Grace (SHA surveyor) inserting with foreign station office_unit_id is blocked by WITH CHECK
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_surveyor')::text, true);

select throws_ok(
  $$insert into party.test_location_job (office_unit_id, title)
    values ((select id from core.org_unit where code = 'NGB'), 'Hacked Ningbo Job')$$,
  '42501', null, 'WITH CHECK blocks inserting office_unit_id outside caller location scope'
);

select lives_ok(
  $$insert into party.test_location_job (office_unit_id, title)
    values ((select id from core.org_unit where code = 'SHA'), 'Valid Shanghai Job')$$,
  'WITH CHECK allows inserting office_unit_id in caller location scope'
);

-- Grace (SHA surveyor) updating office_unit_id on existing Shanghai job to Ningbo is blocked by WITH CHECK
select throws_ok(
  $$update party.test_location_job
       set office_unit_id = (select id from core.org_unit where code = 'NGB')
     where id = 'e0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'WITH CHECK blocks updating office_unit_id to unit outside scope'
);
reset role;

-- Bob (SHA manager) inserting into routed table with foreign handling_unit_id is blocked by WITH CHECK
set local role int_manager;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000004', 'role', 'int_manager')::text, true);

select throws_ok(
  $$insert into party.test_routed_case (handling_unit_id, title)
    values ((select id from core.org_unit where code = 'PA-CAN'), 'Hacked CAN Case')$$,
  '42501', null, 'WITH CHECK blocks inserting handling_unit_id outside caller routed scope'
);
reset role;


-- =========================================================================
-- AC: Expired Memberships / Assignments / Positions / Coverage Denied
-- =========================================================================

-- Expired membership: Carol's membership in Global Maritime expired 1 hour ago
set local role ext_user;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'ext_user')::text, true);

select is((select count(*) from party.organization where id = '99999999-9999-9999-9999-999999999992'), 0::bigint,
          'expired membership denies access to organization in party.organization');
select is((select count(*) from api.organizations where id = '99999999-9999-9999-9999-999999999992'), 0::bigint,
          'expired membership denies access to organization in api.organizations');
reset role;

-- Expired role assignment: Grace has an expired int_auditor assignment
set local role int_auditor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_auditor')::text, true);

select is((select unit_ids from private.my_scope()), '{}'::uuid[],
          'expired role assignment yields empty scope');
select is((select count(*) from party.test_location_job), 0::bigint,
          'expired role assignment denies reading location-scoped jobs');
reset role;

-- Expired staff position: Kevin has position expired 1 hour ago
update iam.staff_position
   set valid = tstzrange(now()-interval '10 days', now()-interval '1 hour')
 where user_id = 'c0000000-0000-0000-0000-00000000000a';

set local role int_viewer;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000a', 'role', 'int_viewer')::text, true);
select is((select count(*) from private.my_position()), 0::bigint,
          'expired staff position yields 0 rows in private.my_position()');
select throws_ok(
  $$select private.assert_authority('survey.report.release', null)$$,
  '42501', 'insufficient_authority',
  'expired staff position denies exercising regulated authority'
);
reset role;

-- Expired coverage: SHA coverage of CAN expired 1 hour ago
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_surveyor')::text, true);
select ok(
  not ((select id from core.org_unit where code = 'CAN') = any (private.my_offices())),
  'expired coverage does not include covered station in private.my_offices()'
);
reset role;


-- =========================================================================
-- AC: Scope from a Non-Active Role Unusable
-- =========================================================================

-- Wendy has int_surveyor @ SHA AND int_coordinator @ NGB.
-- When Wendy activates int_surveyor:
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000b', 'role', 'int_surveyor')::text, true);

select is((select count(*) from party.test_location_job where office_unit_id = (select id from core.org_unit where code = 'SHA')), 3::bigint,
          'active int_surveyor role sees Shanghai jobs');
select is((select count(*) from party.test_location_job where office_unit_id = (select id from core.org_unit where code = 'NGB')), 0::bigint,
          'active int_surveyor role CANNOT use scope from inactive int_coordinator role (Ningbo is hidden)');
reset role;

-- When Wendy activates int_coordinator:
set local role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000b', 'role', 'int_coordinator')::text, true);

select is((select count(*) from party.test_location_job where office_unit_id = (select id from core.org_unit where code = 'NGB')), 1::bigint,
          'active int_coordinator role sees Ningbo jobs');
select is((select count(*) from party.test_location_job where office_unit_id = (select id from core.org_unit where code = 'SHA')), 0::bigint,
          'active int_coordinator role CANNOT use scope from inactive int_surveyor role (Shanghai is hidden)');
reset role;


-- =========================================================================
-- AC: Non-HR Can't Read Grade or Line Manager
-- =========================================================================

-- 1. Direct catalog / table column permissions
set local role int_surveyor;
select throws_ok(
  $$select line_manager_id from iam.staff_position limit 1$$,
  '42501', null, 'int_surveyor cannot select line_manager_id from iam.staff_position'
);
select throws_ok(
  $$select grade from iam.job_title limit 1$$,
  '42501', null, 'int_surveyor cannot select grade from iam.job_title'
);
select throws_ok(
  $$select * from api.staff_positions limit 1$$,
  '42501', null, 'int_surveyor cannot select from api.staff_positions view'
);
reset role;

set local role int_sysadmin;
select throws_ok(
  $$select line_manager_id from iam.staff_position limit 1$$,
  '42501', null, 'int_sysadmin cannot select line_manager_id from iam.staff_position'
);
select throws_ok(
  $$select grade from iam.job_title limit 1$$,
  '42501', null, 'int_sysadmin cannot select grade from iam.job_title'
);
select throws_ok(
  $$select * from api.staff_positions limit 1$$,
  '42501', null, 'int_sysadmin cannot select from api.staff_positions view'
);
reset role;

set local role int_hr;
select lives_ok(
  $$select line_manager_id from iam.staff_position limit 1$$,
  'int_hr can select line_manager_id from iam.staff_position'
);
select lives_ok(
  $$select grade from iam.job_title limit 1$$,
  'int_hr can select grade from iam.job_title'
);
select lives_ok(
  $$select * from api.staff_positions limit 1$$,
  'int_hr can select from api.staff_positions view'
);
reset role;

-- 2. api.user_directory visibility checks
-- Surveyor Grace viewing other staff vs self:
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_surveyor')::text, true);

select is((select grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000004'), null::integer,
          'non-HR viewing another staff member in user_directory sees NULL grade');
select is((select line_manager_id from api.user_directory where id = 'c0000000-0000-0000-0000-000000000004'),
          'c0000000-0000-0000-0000-00000000000c'::uuid,
          'internal staff viewing another staff member in user_directory sees line_manager_id (ADR-0035)');

select is((select grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'), 3,
          'self viewing self in user_directory sees own grade');
select is((select line_manager_id from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'),
          'c0000000-0000-0000-0000-000000000004'::uuid,
          'self viewing self in user_directory sees own line_manager_id');
reset role;

-- Manager Bob viewing direct report Grace vs non-report Alice:
set local role int_manager;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000004', 'role', 'int_manager')::text, true);

select is((select grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'), 3,
          'manager viewing direct report in user_directory sees report grade');
select is((select line_manager_id from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'),
          'c0000000-0000-0000-0000-000000000004'::uuid,
          'manager viewing direct report in user_directory sees report line_manager_id');

select is((select grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000006'), null::integer,
          'manager viewing non-report in user_directory sees NULL grade');
select is((select line_manager_id from api.user_directory where id = 'c0000000-0000-0000-0000-000000000006'),
          'c0000000-0000-0000-0000-00000000000c'::uuid,
          'manager viewing non-report in user_directory sees line_manager_id (ADR-0035)');
reset role;

-- HR Alice viewing staff members:
set local role int_hr;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000003', 'role', 'int_hr')::text, true);

select is((select grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'), 3,
          'HR viewing staff member in user_directory sees actual grade');
select is((select line_manager_id from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'),
          'c0000000-0000-0000-0000-000000000004'::uuid,
          'HR viewing staff member in user_directory sees actual line_manager_id');
reset role;

-- Sysadmin George viewing staff members in user_directory:
set local role int_sysadmin;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000009', 'role', 'int_sysadmin')::text, true);

select is((select grade from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'), null::integer,
          'sysadmin (non-HR) viewing staff in user_directory sees NULL grade');
select is((select line_manager_id from api.user_directory where id = 'c0000000-0000-0000-0000-000000000005'),
          'c0000000-0000-0000-0000-000000000004'::uuid,
          'sysadmin viewing staff in user_directory sees line_manager_id (ADR-0035)');
reset role;

-- 3. Adversary Test: Grade Oracle Exploit Rejection
-- Non-HR Grace attempting to discover Alice HR's grade or any title grade:
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_surveyor')::text, true);

select is(
  private.user_directory_grade('c0000000-0000-0000-0000-000000000003'::uuid),
  null::integer,
  'Adversary: non-HR caller invoking private.user_directory_grade for other staff returns NULL'
);

select throws_ok(
  $$select private.user_directory_grade('c0000000-0000-0000-0000-000000000005'::uuid, 'hr_directors')$$,
  '42883', null,
  'Adversary: function overload accepting arbitrary job_title code is rejected (no grade oracle)'
);
reset role;


-- =========================================================================
-- AC: T9 & I15
-- =========================================================================

-- T9: Routed and location scope cannot be confused
-- Station surveyor (Grace @ SHA) cannot see routed cases
set local role int_surveyor;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000005', 'role', 'int_surveyor')::text, true);
select throws_ok(
  $$select * from party.test_routed_case$$,
  '42501', null, 'T9: station surveyor cannot access routed cases table'
);
reset role;

-- Plan Centre user (Paul @ PA-SHA) cannot access location-scoped jobs
set local role int_viewer;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000d', 'role', 'int_viewer')::text, true);
select is((select count(*) from party.test_location_job), 0::bigint,
          'T9: plan centre user has empty location scope and sees 0 location jobs');
reset role;

-- T9: Scope columns change only through routing/transfer functions
set local role int_manager;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000004', 'role', 'int_manager')::text, true);

-- Direct update to change office_unit_id to Ningbo fails WITH CHECK
select throws_ok(
  $$update party.test_location_job set office_unit_id = (select id from core.org_unit where code = 'NGB') where id = 'e0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'T9: direct update of office_unit_id outside scope fails WITH CHECK'
);

-- Authorized transfer function transfers the job
select lives_ok(
  $$select private.test_transfer_location_job('e0000000-0000-0000-0000-000000000001', (select id from core.org_unit where code = 'NGB'))$$,
  'T9: scope changes through authorized transfer function'
);
reset role;

-- I15: office_unit_id references a station; handling_unit_id references a routed unit or mts_centre
select throws_ok(
  $$insert into party.test_location_job (office_unit_id, title)
    values ((select id from core.org_unit where code = 'HO'), 'Bad Office HO')$$,
  '23514', null, 'I15: office_unit_id cannot reference head_office'
);
select throws_ok(
  $$insert into party.test_location_job (office_unit_id, title)
    values ((select id from core.org_unit where code = 'CN-EAST-RO'), 'Bad Office RO')$$,
  '23514', null, 'I15: office_unit_id cannot reference regional_office'
);
select throws_ok(
  $$insert into party.test_routed_case (handling_unit_id, title)
    values ((select id from core.org_unit where code = 'SHA'), 'Bad Handling Station')$$,
  '23514', null, 'I15: handling_unit_id cannot reference station'
);
select lives_ok(
  $$insert into party.test_routed_case (handling_unit_id, title)
    values ((select id from core.org_unit where code = 'MTS-EAST'), 'Valid Handling MTS')$$,
  'I15: handling_unit_id can reference mts_centre'
);

-- Regional manager Frank (CN-EAST-RO) covers Shanghai and Ningbo
set local role int_manager;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-00000000000c', 'role', 'int_manager')::text, true);
select is((select count(*) from party.test_location_job), 5::bigint,
          'regional area manager sees location jobs across all child stations');
reset role;

-- Global compliance Helen sees everything location-scoped and routed
set local role int_compliance;
select set_config('request.jwt.claims', jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000008', 'role', 'int_compliance')::text, true);
select is((select count(*) from party.test_location_job), 6::bigint,
          'global compliance sees all location jobs worldwide');
select is((select count(*) from party.test_routed_case), 3::bigint,
          'global compliance sees all routed cases worldwide');
reset role;

select * from finish();
rollback;
