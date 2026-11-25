begin;
set search_path = extensions, public;

select plan(24);

\i db/fixtures/org.sql

select has_table('core', 'region', 'core.region exists');
select has_table('core', 'org_unit_type', 'core.org_unit_type exists');
select has_table('core', 'org_unit', 'core.org_unit exists');
select has_table('core', 'org_unit_coverage', 'core.org_unit_coverage exists');
select has_table('core', 'routing_rule', 'core.routing_rule exists');

select is((select count(*) from core.org_unit_type), 6::bigint, 'six organisation unit types seeded');
-- Updated assertion: 6 + 4 - 1 (SHA) = 9
select is((select count(*) from core.org_unit where unit_type = 'station'), 9::bigint, 'nine stations in combined fixtures');
-- Updated assertion: 2 + 3 - 1 (CN-EAST-RO) = 4
select is((select count(*) from core.org_unit where unit_type = 'regional_office'), 4::bigint, 'four regional offices in combined fixtures');

select is(
  (select count(*) from core.org_unit_descendants(array[(select id from core.org_unit where code = 'CN-EAST-RO')])),
  4::bigint,
  'descendants include the root and its three stations'
);

select throws_ok(
  $$insert into core.org_unit (code, name, unit_type, parent_id, region_code)
    values ('BAD', 'Bad Station', 'station', (select id from core.org_unit where code = 'HO'), 'CN-EAST')$$,
  'org_unit_invalid_parent_type: station under head_office',
  'station cannot be parented directly under the head office'
);

select throws_ok(
  $$update core.org_unit set parent_id = id where code = 'HO'$$,
  'P0001',
  'org_unit_head_office_has_no_parent',
  'a unit cannot be its own parent'
);

select throws_ok(
  $$insert into core.org_unit_coverage (unit_id, covered_unit_id, set_by, reason)
    values ((select id from core.org_unit where code = 'MTS-EAST'),
            (select id from core.org_unit where code = 'CN-EAST-RO'),
            '00000000-0000-0000-0000-000000000000', 'overlap')$$,
  '23P01',
  null,
  'overlapping coverage is rejected'
);

select throws_ok(
  $$insert into core.routing_rule (work_type, region_code, handling_unit_id)
    values ('plan.submission', 'CN-EAST', (select id from core.org_unit where code = 'PA-CAN'))$$,
  '23P01',
  null,
  'overlapping routing rule is rejected'
);

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'int_viewer')::text, true);
select throws_ok(
  $$select api.org_unit_create('NOPE', 'Nope', 'station',
      (select id from core.org_unit where code = 'CN-EAST-RO'), 'CN-EAST', null, 'test')$$,
  '42501',
  null,
  'a non-sysadmin cannot create an organisation unit'
);
reset role;

set local role int_sysadmin;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'int_sysadmin',
    'name', 'Sys Admin', 'org_unit_id', (select id::text from core.org_unit where code = 'HO'))::text, true);
select lives_ok(
  $$select api.org_unit_create('TST-ORG', 'Test Organisation Unit', 'station',
      (select id from core.org_unit where code = 'CN-EAST-RO'), 'CN-EAST', null, 'test create')$$,
  'sysadmin can create an organisation unit'
);
select lives_ok(
  $$select api.org_coverage_set((select id from core.org_unit where code = 'MTS-EAST'),
      (select id from core.org_unit where code = 'SHA'), 'test coverage')$$,
  'sysadmin can grant coverage'
);
select lives_ok(
  $$select api.routing_rule_set('plan.submission', 'CN-EAST',
      (select id from core.org_unit where code = 'PA-SHA'), 'test routing')$$,
  'sysadmin can set a routing rule'
);
select throws_ok(
  $$select api.org_coverage_set((select id from core.org_unit where code = 'HO'),
      (select id from core.org_unit where code = 'SHA'), 'own coverage')$$,
  '42501', 'cannot_change_own_coverage',
  'sysadmin cannot change coverage of their own unit'
);
select is(
  (select count(*) from audit_trail.event where event_type = 'org.coverage.granted'),
  1::bigint,
  'coverage change emits an org.coverage.granted event'
);
select is(
  (select count(*) from audit_trail.event where event_type = 'org.routing_rule.changed'),
  1::bigint,
  'routing change emits an org.routing_rule.changed event'
);
reset role;

select is(
  (select count(*) from audit_trail.event e join core.org_unit u on u.id = e.subject_id where e.event_type = 'org.unit.created' and u.code = 'TST-ORG'),
  1::bigint,
  'creating a unit emits an org.unit.created event'
);

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'int_viewer')::text, true);
select is(
  (select count(*) from api.org_units where code = 'TST-ORG'),
  1::bigint,
  'int_viewer can read the org_units view'
);
reset role;

set local role int_sysadmin;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'int_sysadmin')::text, true);
select lives_ok(
  $$select api.org_unit_close((select id from core.org_unit where code = 'TST-ORG'), 'test close')$$,
  'sysadmin can close a unit'
);
reset role;

select is(
  (select active from core.org_unit where code = 'TST-ORG'),
  false,
  'closed unit is inactive'
);

select * from finish();
rollback;
