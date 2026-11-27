-- Development/test organisation fixtures. Idempotent; safe to re-run.
-- HO + four HO departments; two regional offices with three stations each;
-- two plan approval centres; two MTS centres (one covers one region, one covers two).

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select 'HO', 'Head Office', 'head_office', null, null, null
where not exists (select 1 from core.org_unit where code = 'HO');

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'ho_department', ho.id, null, v.code
  from (values
    ('HO-COMP', 'HO Compliance'),
    ('HO-HR', 'HO Human Resources'),
    ('HO-FIN', 'HO Finance'),
    ('HO-IT', 'HO Information Technology')
  ) as v(code, name)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'regional_office', ho.id, v.region_code, null
  from (values
    ('CN-EAST-RO', 'East China Regional Office', 'CN-EAST'),
    ('CN-SOUTH-RO', 'South China Regional Office', 'CN-SOUTH')
  ) as v(code, name, region_code)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'station', ro.id, v.region_code, null
  from (values
    ('SHA', 'Shanghai Station', 'CN-EAST-RO', 'CN-EAST'),
    ('NGB', 'Ningbo Station', 'CN-EAST-RO', 'CN-EAST'),
    ('HGH', 'Hangzhou Station', 'CN-EAST-RO', 'CN-EAST'),
    ('CAN', 'Guangzhou Station', 'CN-SOUTH-RO', 'CN-SOUTH'),
    ('SZX', 'Shenzhen Station', 'CN-SOUTH-RO', 'CN-SOUTH'),
    ('XMN', 'Xiamen Station', 'CN-SOUTH-RO', 'CN-SOUTH')
  ) as v(code, name, parent_code, region_code)
  join core.org_unit ro on ro.code = v.parent_code
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'plan_approval_centre', ho.id, null, null
  from (values
    ('PA-SHA', 'Shanghai Plan Approval Centre'),
    ('PA-CAN', 'Guangzhou Plan Approval Centre')
  ) as v(code, name)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'mts_centre', ho.id, v.region_code, null
  from (values
    ('MTS-EAST', 'East China MTS Centre', 'CN-EAST'),
    ('MTS-ASIA', 'Asia MTS Centre', 'CN-EAST')
  ) as v(code, name, region_code)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit_coverage (unit_id, covered_unit_id, set_by, reason)
select m.id, r.id, '00000000-0000-0000-0000-000000000000', 'fixture'
  from core.org_unit m
  join core.org_unit r on r.code = 'CN-EAST-RO'
 where m.code = 'MTS-EAST'
   and not exists (
     select 1 from core.org_unit_coverage c
      where c.unit_id = m.id and c.covered_unit_id = r.id and upper_inf(c.valid)
   );

insert into core.org_unit_coverage (unit_id, covered_unit_id, set_by, reason)
select m.id, r.id, '00000000-0000-0000-0000-000000000000', 'fixture'
  from core.org_unit m
  join core.org_unit r on r.code in ('CN-EAST-RO', 'CN-SOUTH-RO')
 where m.code = 'MTS-ASIA'
   and not exists (
     select 1 from core.org_unit_coverage c
      where c.unit_id = m.id and c.covered_unit_id = r.id and upper_inf(c.valid)
   );

insert into core.routing_rule (work_type, region_code, handling_unit_id)
select v.work_type, v.region_code, u.id
  from (values
    ('plan.submission', 'CN-EAST', 'PA-SHA'),
    ('plan.submission', 'CN-SOUTH', 'PA-CAN'),
    ('plan.submission', null, 'PA-SHA'),
    ('mts.case', 'CN-EAST', 'MTS-EAST'),
    ('mts.case', 'CN-SOUTH', 'MTS-ASIA')
  ) as v(work_type, region_code, handling_code)
  join core.org_unit u on u.code = v.handling_code
 where not exists (
   select 1 from core.routing_rule r
    where r.work_type = v.work_type
      and r.region_code is not distinct from v.region_code
      and upper_inf(r.valid)
 );
-- R8.6 Deterministic Acceptance Test Fixtures
-- Synthetic, version-controlled, repeatable, safe to destroy.

-- 1. Regions
insert into core.region (code, name) values
  ('CN-EAST', 'East China'),
  ('CN-SOUTH', 'South China'),
  ('EUR', 'Europe')
on conflict (code) do update set name = excluded.name;

-- 2. Organizations / Org Units
insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select 'HO', 'Head Office', 'head_office', null, null, null
where not exists (select 1 from core.org_unit where code = 'HO');

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'ho_department', ho.id, null, v.code
  from (values
    ('HO-COMP', 'HO Compliance'),
    ('HO-HR', 'HO Human Resources'),
    ('HO-FIN', 'HO Finance'),
    ('HO-IT', 'HO Information Technology')
  ) as v(code, name)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'regional_office', ho.id, v.region_code, null
  from (values
    ('ASIA-RO', 'Asia Regional Office', 'CN-EAST'),
    ('CN-EAST-RO', 'East China Regional Office', 'CN-EAST'),
    ('EUR-RO', 'Europe Regional Office', 'EUR')
  ) as v(code, name, region_code)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'station', ro.id, v.region_code, null
  from (values
    ('SHA', 'Shanghai Station', 'ASIA-RO', 'CN-EAST'),
    ('SIN', 'Singapore Station', 'ASIA-RO', 'CN-EAST'),
    ('PUS', 'Busan Station', 'ASIA-RO', 'CN-EAST'),
    ('GOA', 'Genoa Station', 'EUR-RO', 'EUR')
  ) as v(code, name, parent_code, region_code)
  join core.org_unit ro on ro.code = v.parent_code
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'plan_approval_centre', ho.id, null, null
  from (values
    ('PA-CENTRAL', 'Central Plan Approval Centre'),
    ('PA-SHA', 'Shanghai Plan Approval Centre')
  ) as v(code, name)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
select v.code, v.name, 'mts_centre', ho.id, v.region_code, null
  from (values
    ('MTS-ASIA', 'Asia MTS Centre', 'CN-EAST'),
    ('MTS-EAST', 'East China MTS Centre', 'CN-EAST')
  ) as v(code, name, region_code)
  cross join (select id from core.org_unit where code = 'HO') ho
where not exists (select 1 from core.org_unit u where u.code = v.code);

-- Coverage
insert into core.org_unit_coverage (unit_id, covered_unit_id, set_by, reason)
select m.id, r.id, '00000000-0000-4000-8000-000000000001', 'fixture'
  from core.org_unit m
  join core.org_unit r on r.code = 'ASIA-RO'
 where m.code = 'MTS-ASIA'
   and not exists (
     select 1 from core.org_unit_coverage c
      where c.unit_id = m.id and c.covered_unit_id = r.id and upper_inf(c.valid)
   );

-- 3. Synthetic Customer Companies
insert into party.organization (id, name, org_type, status)
values
  ('00000000-0000-4000-8000-0000000000a1', 'TEST ABC SHIPPING LTD', 'company', 'active'),
  ('00000000-0000-4000-8000-0000000000b1', 'TEST XYZ MARITIME LTD', 'company', 'active')
on conflict (id) do update set
  name = excluded.name,
  org_type = excluded.org_type,
  status = excluded.status;

-- 4. Synthetic Vessels
insert into fleet.ship (id, imo_number, name, type_iacs, type_mms, flag_code, status, responsible_mts_unit_id)
select v.id, v.imo_number, v.name, v.type_iacs, v.type_mms, v.flag_code, 'in_service', m.id
from (values
  ('00000000-0000-4000-8000-000000000a01'::uuid, '9990001', 'MV TEST ALPHA', 'BC', 'BC', 'PA'),
  ('00000000-0000-4000-8000-000000000a02'::uuid, '9990002', 'MV TEST BRAVO', 'BC', 'BC', 'LR'),
  ('00000000-0000-4000-8000-000000000b01'::uuid, '9990003', 'MV TEST CHARLIE', 'BC', 'BC', 'SG')
) as v(id, imo_number, name, type_iacs, type_mms, flag_code)
cross join (select id from core.org_unit where code = 'MTS-ASIA') m
on conflict (id) do update set
  imo_number = excluded.imo_number,
  name = excluded.name,
  type_iacs = excluded.type_iacs,
  type_mms = excluded.type_mms,
  flag_code = excluded.flag_code;

-- Link Ships to Organizations
insert into fleet.ship_party (id, ship_id, org_id, party_role, valid)
values
  ('00000000-0000-4000-8000-000000000aa1', '00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000000a1', 'registered_owner', tstzrange(now() - interval '1 year', null)),
  ('00000000-0000-4000-8000-000000000aa2', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000a1', 'registered_owner', tstzrange(now() - interval '1 year', null)),
  ('00000000-0000-4000-8000-000000000bb1', '00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000000b1', 'registered_owner', tstzrange(now() - interval '1 year', null))
on conflict (id) do nothing;

-- 5. System Bootstrap User (for set_by / granted_by foreign keys)
insert into iam.app_user (id, kind, display_name, status, entra_tenant_id, entra_object_id)
values (
  '00000000-0000-4000-8000-000000000001',
  'internal',
  'System Bootstrap Admin',
  'active',
  '00000000-0000-4000-a000-000000000001',
  '00000000-0000-4000-b000-000000000001'
)
on conflict (id) do update set status = 'active';

-- 6. Test Personas
insert into iam.app_user (id, kind, display_name, email, email_verified_at, status, entra_tenant_id, entra_object_id)
values
  -- External Personas
  ('00000000-0000-4000-8000-000000000101', 'external', 'External Customer A', 'customer.a@test.mms.local', now(), 'active', null, null),
  ('00000000-0000-4000-8000-000000000102', 'external', 'External Customer B', 'customer.b@test.mms.local', now(), 'active', null, null),

  -- Internal Personas
  ('00000000-0000-4000-8000-000000000103', 'internal', 'Shanghai Surveyor', 'surveyor.shanghai@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000103'),
  ('00000000-0000-4000-8000-000000000104', 'internal', 'Shanghai Auditor', 'auditor.shanghai@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000104'),
  ('00000000-0000-4000-8000-000000000105', 'internal', 'Shanghai Station Manager', 'manager.shanghai@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000105'),
  ('00000000-0000-4000-8000-000000000106', 'internal', 'Singapore Surveyor', 'surveyor.singapore@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000106'),
  ('00000000-0000-4000-8000-000000000107', 'internal', 'Asia Coordinator', 'coordinator.asia@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000107'),
  ('00000000-0000-4000-8000-000000000108', 'internal', 'Asia MTS Specialist', 'mts.asia@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000108'),
  ('00000000-0000-4000-8000-000000000109', 'internal', 'Plan Approval Central Engineer', 'planapproval.central@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000109'),
  ('00000000-0000-4000-8000-000000000110', 'internal', 'HO Compliance Officer', 'compliance.ho@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000110'),
  ('00000000-0000-4000-8000-000000000111', 'internal', 'Test HR Officer', 'hr.test@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000111'),
  ('00000000-0000-4000-8000-000000000112', 'internal', 'Test Finance Officer', 'finance.test@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000112'),
  ('00000000-0000-4000-8000-000000000113', 'internal', 'Test Sysadmin', 'sysadmin.test@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000113'),
  ('00000000-0000-4000-8000-000000000114', 'internal', 'Expired Qualification Surveyor', 'surveyor.expired@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000114'),
  ('00000000-0000-4000-8000-000000000115', 'internal', 'Test Break Glass', 'breakglass.test@test.mms.local', now(), 'active', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000115')
on conflict (id) do update set
  display_name = excluded.display_name,
  status = 'active',
  email = excluded.email;

-- External Memberships
insert into iam.org_membership (id, user_id, user_kind, org_id, member_role, valid, granted_by)
values
  ('00000000-0000-4000-8000-000000000ea1', '00000000-0000-4000-8000-000000000101', 'external', '00000000-0000-4000-8000-0000000000a1', 'org_admin', tstzrange(now() - interval '1 year', null), '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000eb1', '00000000-0000-4000-8000-000000000102', 'external', '00000000-0000-4000-8000-0000000000b1', 'org_admin', tstzrange(now() - interval '1 year', null), '00000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

-- External Passwords ($argon2id$v=19$m=65536,t=3,p=4$4S9u... for 'TestPassword123!')
insert into iam.password_credential (user_id, user_kind, hash)
values
  ('00000000-0000-4000-8000-000000000101', 'external', '$argon2id$v=19$m=65536,t=3,p=4$rYm+8Y4QW/v6E7Lg4JjQzA$0yJ3Y7bWc7Y+xU7L6fU5HjE5R3o8mU7W1eY8bWc7Y+w'),
  ('00000000-0000-4000-8000-000000000102', 'external', '$argon2id$v=19$m=65536,t=3,p=4$rYm+8Y4QW/v6E7Lg4JjQzA$0yJ3Y7bWc7Y+xU7L6fU5HjE5R3o8mU7W1eY8bWc7Y+w')
on conflict (user_id) do nothing;

-- 7. Internal Positions & Role Assignments
-- Helper block using DO
do $$
declare
  v_sha_id uuid;
  v_sin_id uuid;
  v_asia_ro_id uuid;
  v_mts_asia_id uuid;
  v_pa_central_id uuid;
  v_ho_comp_id uuid;
  v_ho_hr_id uuid;
  v_ho_fin_id uuid;
  v_ho_it_id uuid;
  v_admin_id uuid := '00000000-0000-4000-8000-000000000001';
begin
  select id into v_sha_id from core.org_unit where code = 'SHA';
  select id into v_sin_id from core.org_unit where code = 'SIN';
  select id into v_asia_ro_id from core.org_unit where code = 'ASIA-RO';
  select id into v_mts_asia_id from core.org_unit where code = 'MTS-ASIA';
  select id into v_pa_central_id from core.org_unit where code = 'PA-CENTRAL';
  select id into v_ho_comp_id from core.org_unit where code = 'HO-COMP';
  select id into v_ho_hr_id from core.org_unit where code = 'HO-HR';
  select id into v_ho_fin_id from core.org_unit where code = 'HO-FIN';
  select id into v_ho_it_id from core.org_unit where code = 'HO-IT';

  -- surveyor.shanghai
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000103', 'internal', 'surveyors', 'survey', v_sha_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000103', 'internal', 'int_surveyor', 'unit', v_sha_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- auditor.shanghai
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000104', 'internal', 'auditors', 'audit', v_sha_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000104', 'internal', 'int_auditor', 'unit', v_sha_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- manager.shanghai
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000105', 'internal', 'managers', 'management', v_sha_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000105', 'internal', 'int_manager', 'unit', v_sha_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- surveyor.singapore
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000106', 'internal', 'surveyors', 'survey', v_sin_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000106', 'internal', 'int_surveyor', 'unit', v_sin_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- coordinator.asia
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000107', 'internal', 'senior_admins', 'office_admin', v_asia_ro_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000107', 'internal', 'int_coordinator', 'unit', v_asia_ro_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- mts.asia
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000108', 'internal', 'senior_engineers', 'mts', v_mts_asia_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000108', 'internal', 'int_surveyor', 'unit', v_mts_asia_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- planapproval.central
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000109', 'internal', 'senior_engineers', 'plan', v_pa_central_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000109', 'internal', 'int_surveyor', 'unit', v_pa_central_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- compliance.ho
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000110', 'internal', 'senior_compliance_officers', 'compliance', v_ho_comp_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000110', 'internal', 'int_compliance', 'global', 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- hr.test
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000111', 'internal', 'senior_hr', 'hr', v_ho_hr_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000111', 'internal', 'int_hr', 'global', 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- finance.test
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000112', 'internal', 'senior_finance', 'finance', v_ho_fin_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000112', 'internal', 'int_finance', 'global', 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- sysadmin.test
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000113', 'internal', 'senior_admins', 'office_admin', v_ho_it_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000113', 'internal', 'int_sysadmin', 'global', 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- surveyor.expired
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000114', 'internal', 'surveyors', 'survey', v_sha_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
  insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, valid, granted_by, grant_reason)
  values ('00000000-0000-4000-8000-000000000114', 'internal', 'int_surveyor', 'unit', v_sha_id, 'manual', tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;

  -- breakglass.test
  insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
  values ('00000000-0000-4000-8000-000000000115', 'internal', 'senior_admins', 'office_admin', v_ho_it_id, tstzrange(now() - interval '1 year', null), v_admin_id, 'test fixture')
  on conflict do nothing;
end $$;

-- 8. Qualifications
insert into qual.qualification (code, name, job_family, description)
values
  ('TEST_GENERAL_SURVEY', 'Test General Survey Qualification', 'survey', 'Qualification for standard hull/machinery survey release'),
  ('TEST_SPECIAL_SURVEY', 'Test Special Survey Qualification', 'survey', 'Qualification for advanced statutory/special survey release')
on conflict (code) do update set
  name = excluded.name,
  job_family = excluded.job_family;

insert into qual.qualification_action (qualification_code, action_code) values
  ('TEST_GENERAL_SURVEY', 'survey.report.release'),
  ('TEST_SPECIAL_SURVEY', 'survey.report.release')
on conflict do nothing;

-- Staff qualifications:
-- surveyor.shanghai: active TEST_GENERAL_SURVEY
insert into qual.staff_qualification (user_id, qualification_code, valid, granted_by, grant_reason)
values (
  '00000000-0000-4000-8000-000000000103',
  'TEST_GENERAL_SURVEY',
  tstzrange(now() - interval '1 year', null),
  '00000000-0000-4000-8000-000000000001',
  'Onboarding qualification'
)
on conflict do nothing;

-- surveyor.singapore: active TEST_SPECIAL_SURVEY
insert into qual.staff_qualification (user_id, qualification_code, valid, granted_by, grant_reason)
values (
  '00000000-0000-4000-8000-000000000106',
  'TEST_SPECIAL_SURVEY',
  tstzrange(now() - interval '1 year', null),
  '00000000-0000-4000-8000-000000000001',
  'Onboarding qualification'
)
on conflict do nothing;

-- surveyor.expired: EXPIRED TEST_GENERAL_SURVEY
insert into qual.staff_qualification (user_id, qualification_code, valid, granted_by, grant_reason)
values (
  '00000000-0000-4000-8000-000000000114',
  'TEST_GENERAL_SURVEY',
  tstzrange(now() - interval '1 year', now() - interval '1 month'),
  '00000000-0000-4000-8000-000000000001',
  'Expired qualification'
)
on conflict do nothing;

-- 9. Break Glass Account
insert into iam.break_glass_account (user_id, label, enabled, last_drill_at)
values ('00000000-0000-4000-8000-000000000115', 'Acceptance Test Break Glass Account', true, now())
on conflict (user_id) do update set enabled = true, last_drill_at = now();

-- 10. Workflow Fixtures: survey.survey_request
insert into survey.survey_request (
  id, request_no, ship_id, org_id, office_unit_id, status,
  survey_types, port_name, port_country, port_code,
  estimated_arrival, estimated_departure, agent_contact, scope_description, triage_notes,
  created_by
)
select
  v.id, v.request_no, v.ship_id, v.org_id, u.id, v.status,
  v.survey_types, v.port_name, 'CN', v.port_code,
  now() + interval '3 days', now() + interval '7 days', '{"name":"Local Agent"}'::jsonb, v.scope_desc, v.triage_notes,
  '00000000-0000-4000-8000-000000000101'
from (values
  ('00000000-0000-4000-8000-000000000201'::uuid, 'SR-TEST-001', '00000000-0000-4000-8000-000000000a01'::uuid, '00000000-0000-4000-8000-0000000000a1'::uuid, 'draft', array['annual_hull'], 'Shanghai Port', 'CNSHA', 'Draft survey request', null),
  ('00000000-0000-4000-8000-000000000202'::uuid, 'SR-TEST-002', '00000000-0000-4000-8000-000000000a01'::uuid, '00000000-0000-4000-8000-0000000000a1'::uuid, 'submitted', array['annual_machinery'], 'Shanghai Port', 'CNSHA', 'Submitted survey request for triage', null),
  ('00000000-0000-4000-8000-000000000203'::uuid, 'SR-TEST-003', '00000000-0000-4000-8000-000000000a02'::uuid, '00000000-0000-4000-8000-0000000000a1'::uuid, 'clarification_requested', array['special_survey'], 'Shanghai Port', 'CNSHA', 'Under triage: clarification needed', 'Please provide latest drydock report'),
  ('00000000-0000-4000-8000-000000000204'::uuid, 'SR-TEST-004', '00000000-0000-4000-8000-000000000a02'::uuid, '00000000-0000-4000-8000-0000000000a1'::uuid, 'accepted', array['intermediate_hull'], 'Shanghai Port', 'CNSHA', 'Accepted survey request', 'Assigned team confirmed'),
  ('00000000-0000-4000-8000-000000000205'::uuid, 'SR-TEST-005', '00000000-0000-4000-8000-000000000a02'::uuid, '00000000-0000-4000-8000-0000000000a1'::uuid, 'rejected', array['special_survey'], 'Shanghai Port', 'CNSHA', 'Rejected survey request', 'Port not within service perimeter')
) as v(id, request_no, ship_id, org_id, status, survey_types, port_name, port_code, scope_desc, triage_notes)
cross join (select id from core.org_unit where code = 'SHA') u
on conflict (id) do update set
  status = excluded.status,
  triage_notes = excluded.triage_notes;