begin;
set search_path = extensions, public;

-- Card H-08 (Q4, ADR-0018): delegated organisation administration.
--
-- A regional administrator may maintain the part of the tree they already
-- administer, using the ordinary authority rules. Everything that would let them
-- reach outside that subtree, or reshape it, is refused. Each refusal below is a
-- separate assertion because each one is a distinct way to escalate.
select plan(17);

\i db/fixtures/org.sql

-- Staff tenant and users. The delegated administrator sits at CN-EAST-RO; the
-- second one sits at CN-SOUTH-RO so a cross-region attempt has a real target.
insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values
  ('c8000000-0000-0000-0000-000000000001', 'internal', 'East Admin',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c8000000-0000-0000-0000-000000000001', 'active'),
  ('c8000000-0000-0000-0000-000000000002', 'internal', 'East Coordinator',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c8000000-0000-0000-0000-000000000002', 'active'),
  ('c8000000-0000-0000-0000-000000000003', 'internal', 'South Admin',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c8000000-0000-0000-0000-000000000003', 'active'),
  ('c8000000-0000-0000-0000-000000000004', 'internal', 'Junior East Admin',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c8000000-0000-0000-0000-000000000004', 'active'),
  ('c8000000-0000-0000-0000-000000000099', 'internal', 'Sysadmin',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c8000000-0000-0000-0000-000000000099', 'active');

-- Positions. `managers` is grade 4 (management family) at a regional office; the
-- `senior_admins` actor is grade 3, which satisfies the create rule (min 3) but not
-- the close rule (int_manager + min 4), so the two refusals test different causes.
insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c8000000-0000-0000-0000-000000000101', 'c8000000-0000-0000-0000-000000000001', 'internal',
       'managers', 'management', u.id,
       tstzrange(now() - interval '1 day', now() + interval '1 day'),
       'c8000000-0000-0000-0000-000000000002', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c8000000-0000-0000-0000-000000000102', 'c8000000-0000-0000-0000-000000000002', 'internal',
       'admins', 'office_admin', u.id,
       tstzrange(now() - interval '1 day', now() + interval '1 day'),
       'c8000000-0000-0000-0000-000000000001', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c8000000-0000-0000-0000-000000000103', 'c8000000-0000-0000-0000-000000000003', 'internal',
       'managers', 'management', u.id,
       tstzrange(now() - interval '1 day', now() + interval '1 day'),
       'c8000000-0000-0000-0000-000000000002', 'test setup'
  from core.org_unit u where u.code = 'CN-SOUTH-RO';

insert into iam.staff_position (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
select 'c8000000-0000-0000-0000-000000000104', 'c8000000-0000-0000-0000-000000000004', 'internal',
       'admins', 'office_admin', u.id,
       tstzrange(now() - interval '1 day', now() + interval '1 day'),
       'c8000000-0000-0000-0000-000000000001', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

-- Role assignments, scoped to the regional office the administrator sits in.
insert into iam.role_assignment (id, user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c8000000-0000-0000-0000-000000000201', 'c8000000-0000-0000-0000-000000000001', 'internal',
       'int_manager', 'unit', u.id, 'manual',
       'c8000000-0000-0000-0000-000000000099', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.role_assignment (id, user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c8000000-0000-0000-0000-000000000202', 'c8000000-0000-0000-0000-000000000002', 'internal',
       'int_manager', 'unit', u.id, 'manual',
       'c8000000-0000-0000-0000-000000000099', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.role_assignment (id, user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c8000000-0000-0000-0000-000000000203', 'c8000000-0000-0000-0000-000000000003', 'internal',
       'int_coordinator', 'unit', u.id, 'manual',
       'c8000000-0000-0000-0000-000000000099', 'test setup'
  from core.org_unit u where u.code = 'CN-SOUTH-RO';

insert into iam.role_assignment (id, user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
select 'c8000000-0000-0000-0000-000000000204', 'c8000000-0000-0000-0000-000000000004', 'internal',
       'int_manager', 'unit', u.id, 'manual',
       'c8000000-0000-0000-0000-000000000099', 'test setup'
  from core.org_unit u where u.code = 'CN-EAST-RO';

select is(
  (select count(*) from iam.authority_rule where action_code = 'org.unit.create'),
  2::bigint, 'two delegated create rules are seeded (coordinator and manager)');

select is(
  (select count(*) from iam.authority_rule where action_code = 'org.unit.close'),
  1::bigint, 'one delegated close rule is seeded (manager only)');

-- function_code is only meaningful for ho_department (org_unit_function_ck), so the
-- station arguments below pass null.

-- 1. The delegated create works inside the caller's own subtree.
set role int_manager;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'c8000000-0000-0000-0000-000000000001',
  'role', 'int_manager'
)::text, true);

select ok(
  (api.org_unit_create(
    'CN-EAST-NEW', 'New East Station', 'station',
    (select id from core.org_unit where code = 'CN-EAST-RO'),
    'CN-EAST', null, 'new station for the east region'
  )) is not null,
  'a regional administrator creates a station under their own regional office'
);

select is(
  (select count(*) from audit_trail.event
    where event_type = 'org.unit.created' and reason = 'new station for the east region'),
  1::bigint, 'the delegated create is recorded in the audit trail');

-- 2. Outside the scope is refused, even with the right grade and role.
select throws_ok(
  $$select api.org_unit_create(
      'CN-SOUTH-NEW', 'New South Station', 'station',
      (select id from core.org_unit where code = 'CN-SOUTH-RO'),
      'CN-SOUTH', null, 'cross-region attempt')$$,
  '42501', 'out_of_scope',
  'a regional administrator cannot create a station under another region'
);

-- 3. Below the minimum grade is refused by the authority rule.
set role int_manager;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'c8000000-0000-0000-0000-000000000004',
  'role', 'int_manager'
)::text, true);

select throws_ok(
  $$select api.org_unit_create(
      'CN-EAST-JUNIOR', 'Junior Station', 'station',
      (select id from core.org_unit where code = 'CN-EAST-RO'),
      'CN-EAST', null, 'junior attempt')$$,
  '42501', 'insufficient_authority',
  'a grade-2 administrator cannot create units (rule needs grade 3)'
);

-- 4. Renaming inside the scope is allowed; re-parenting is not.
set role int_manager;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'c8000000-0000-0000-0000-000000000001',
  'role', 'int_manager'
)::text, true);

select lives_ok(
  $$select api.org_unit_update(
      (select id from core.org_unit where code = 'SHA'),
      'Shanghai Station (renamed)',
      (select parent_id from core.org_unit where code = 'SHA'),
      'CN-EAST', null, 'rename for clarity')$$,
  'a regional administrator renames a station inside their scope'
);

select is(
  (select name from core.org_unit where code = 'SHA'),
  'Shanghai Station (renamed)', 'the rename took effect');

select throws_ok(
  $$select api.org_unit_update(
      (select id from core.org_unit where code = 'SHA'),
      'Shanghai Station',
      (select id from core.org_unit where code = 'CN-SOUTH-RO'),
      'CN-EAST', null, 'reparent attempt')$$,
  '42501', 'parent_change_requires_sysadmin',
  'a regional administrator cannot re-parent a unit, even inside their scope'
);

select is(
  (select parent_id from core.org_unit where code = 'SHA'),
  (select id from core.org_unit where code = 'CN-EAST-RO'),
  'the refused re-parent left the tree unchanged');

-- 5. Closing: manager may, coordinator may not (no close rule for that role).
select lives_ok(
  $$select api.org_unit_close(
      (select id from core.org_unit where code = 'CN-EAST-NEW'),
      'new station cancelled')$$,
  'a regional manager closes a station inside their scope'
);

select is(
  (select active from core.org_unit where code = 'CN-EAST-NEW'),
  false, 'the closed unit is inactive');

set role int_coordinator;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'c8000000-0000-0000-0000-000000000003',
  'role', 'int_coordinator'
)::text, true);

select throws_ok(
  $$select api.org_unit_close(
      (select id from core.org_unit where code = 'CAN'),
      'coordinator attempt')$$,
  '42501', 'insufficient_authority',
  'a coordinator has no org.unit.close rule'
);

-- 6. Coverage and routing stay sysadmin-only for the delegated role.
select throws_ok(
  $$select api.org_coverage_set(
      (select id from core.org_unit where code = 'CN-SOUTH-RO'),
      (select id from core.org_unit where code = 'CAN'),
      'widen my reach')$$,
  '42501', null,
  'coverage changes are not delegated'
);

reset role;

-- 7. A sysadmin keeps the unconditional path.
set role int_sysadmin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'c8000000-0000-0000-0000-000000000099',
  'role', 'int_sysadmin'
)::text, true);

select ok(
  (api.org_unit_create(
    'CN-WEST-RO', 'West Regional Office', 'regional_office',
    (select id from core.org_unit where code = 'HO'),
    'CN-EAST', null, 'sysadmin creates a region'
  )) is not null,
  'a sysadmin creates a regional office at the top of the tree'
);

select lives_ok(
  $$select api.org_unit_update(
      (select id from core.org_unit where code = 'SHA'),
      'Shanghai Station',
      (select id from core.org_unit where code = 'CN-EAST-RO'),
      'CN-EAST', null, 'sysadmin re-parent is allowed')$$,
  'a sysadmin may still re-parent a unit'
);

reset role;

-- 8. Nothing above the caller can be created by a delegated caller.
set role int_manager;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'c8000000-0000-0000-0000-000000000001',
  'role', 'int_manager'
)::text, true);

select throws_ok(
  $$select api.org_unit_create(
      'HO-NEW', 'Head Office Annex', 'ho_department',
      (select id from core.org_unit where code = 'HO'),
      null, 'office', 'top-of-tree attempt')$$,
  '42501', 'out_of_scope',
  'a regional administrator cannot add a department to the head office'
);

reset role;

select * from finish();
rollback;
