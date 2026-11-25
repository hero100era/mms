begin;
set search_path = extensions, public;

select plan(32);

\i db/fixtures/org.sql

-- 1. Structural assertions
select has_column('core', 'org_unit', 'level', 'core.org_unit has level column');
select has_column('core', 'org_unit', 'path', 'core.org_unit has path ltree column');
select has_view('api', 'org_unit_hierarchy', 'api.org_unit_hierarchy view exists');
select has_view('api', 'org_chart_nodes', 'api.org_chart_nodes view exists');
select has_function('api', 'org_chart_management_chain', array['uuid'], 'api.org_chart_management_chain exists');
select has_function('api', 'org_chart_reports', array['uuid', 'integer'], 'api.org_chart_reports exists');
select has_function('api', 'org_chart_peers', array['uuid'], 'api.org_chart_peers exists');
select has_function('api', 'org_chart_for_user', array['uuid'], 'api.org_chart_for_user exists');

-- 2. Materialized ltree path & level on core.org_unit
select is((select level from core.org_unit where code = 'HO'), 0, 'HO has level 0');
select is((select path::text from core.org_unit where code = 'HO'), 'HO', 'HO has path HO');
select is((select level from core.org_unit where code = 'CN-EAST-RO'), 1, 'CN-EAST-RO has level 1');
select is((select path::text from core.org_unit where code = 'CN-EAST-RO'), 'HO.CN_EAST_RO', 'CN-EAST-RO has sanitized ltree path');
select is((select level from core.org_unit where code = 'SHA'), 2, 'SHA has level 2');
select is((select path::text from core.org_unit where code = 'SHA'), 'HO.CN_EAST_RO.SHA', 'SHA has full ltree path under CN-EAST-RO');

-- 3. Fixture org chart hierarchy (MD -> Area Mgr -> Station Mgr -> Senior Surveyor & Coord -> Junior Surveyor)
insert into iam.app_user (id, kind, display_name, email, entra_tenant_id, entra_object_id, status) values
  ('e1000000-0000-0000-0000-000000000001', 'internal', 'Alice MD', 'alice.md@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-1111-1111-1111-111111111111', 'active'),
  ('e1000000-0000-0000-0000-000000000002', 'internal', 'Bob AreaMgr', 'bob.area@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-2222-2222-2222-222222222222', 'active'),
  ('e1000000-0000-0000-0000-000000000003', 'internal', 'Carol StationMgr', 'carol.sha@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-3333-3333-3333-333333333333', 'active'),
  ('e1000000-0000-0000-0000-000000000004', 'internal', 'Dan SeniorSurveyor', 'dan.surv@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-4444-4444-4444-444444444444', 'active'),
  ('e1000000-0000-0000-0000-000000000005', 'internal', 'Eve Coordinator', 'eve.coord@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-5555-5555-5555-555555555555', 'active'),
  ('e1000000-0000-0000-0000-000000000006', 'internal', 'Frank JuniorSurveyor', 'frank.jr@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-6666-6666-6666-666666666666', 'active'),
  ('e1000000-0000-0000-0000-000000000007', 'internal', 'Gina Deactivated', 'gina.gone@mms.example.com', '11111111-1111-1111-1111-111111111111', 'e1000000-7777-7777-7777-777777777777', 'deactivated');

insert into iam.app_user (id, kind, display_name, email, status) values
  ('e1000000-0000-0000-0000-000000000008', 'external', 'Ext Customer', 'ext@ship.example.com', 'active');

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000001', 'managing_directors', 'management', u.id, null, tstzrange(now()-interval '1 day', null), 'e1000000-0000-0000-0000-000000000002', 'org chart fixture'
  from core.org_unit u where u.code = 'HO';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000002', 'senior_managers', 'management', u.id, 'e1000000-0000-0000-0000-000000000001', tstzrange(now()-interval '1 day', null), 'e1000000-0000-0000-0000-000000000001', 'org chart fixture'
  from core.org_unit u where u.code = 'CN-EAST-RO';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000003', 'managers', 'management', u.id, 'e1000000-0000-0000-0000-000000000002', tstzrange(now()-interval '1 day', null), 'e1000000-0000-0000-0000-000000000001', 'org chart fixture'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000004', 'senior_surveyors', 'survey', u.id, 'e1000000-0000-0000-0000-000000000003', tstzrange(now()-interval '1 day', null), 'e1000000-0000-0000-0000-000000000001', 'org chart fixture'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000005', 'admins', 'office_admin', u.id, 'e1000000-0000-0000-0000-000000000003', tstzrange(now()-interval '1 day', null), 'e1000000-0000-0000-0000-000000000001', 'org chart fixture'
  from core.org_unit u where u.code = 'SHA';

insert into iam.staff_position (user_id, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
select 'e1000000-0000-0000-0000-000000000006', 'junior_surveyors', 'survey', u.id, 'e1000000-0000-0000-0000-000000000004', tstzrange(now()-interval '1 day', null), 'e1000000-0000-0000-0000-000000000001', 'org chart fixture'
  from core.org_unit u where u.code = 'SHA';

-- Query as ordinary internal viewer (int_viewer)
set local role int_viewer;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'e1000000-0000-0000-0000-000000000006',
  'role', 'int_viewer'
)::text, true);

select is(
  (select full_path from api.org_unit_hierarchy where code = 'SHA'),
  'Head Office > East China Regional Office > Shanghai Station',
  'api.org_unit_hierarchy computes full breadcrumb path'
);
select is(
  (select direct_staff_count from api.org_unit_hierarchy where code = 'SHA'),
  (
    select count(*)
      from iam.staff_position p
      join iam.app_user au on au.id = p.user_id
     where p.unit_id = (select id from core.org_unit where code = 'SHA')
       and p.valid @> now()
       and au.kind = 'internal'
       and au.status in ('active', 'invited')
  ),
  'api.org_unit_hierarchy counts active internal staff in SHA'
);
select is(
  (select manager_name from api.org_chart_nodes where user_id = 'e1000000-0000-0000-0000-000000000004'),
  'Carol StationMgr',
  'int_viewer sees manager_name in api.org_chart_nodes'
);
select is(
  (select direct_reports_count from api.org_chart_nodes where user_id = 'e1000000-0000-0000-0000-000000000003'),
  2::bigint,
  'api.org_chart_nodes reports direct_reports_count accurately'
);
select is(
  (select count(*) from api.org_chart_nodes where user_id in ('e1000000-0000-0000-0000-000000000007', 'e1000000-0000-0000-0000-000000000008')),
  0::bigint,
  'api.org_chart_nodes excludes deactivated and external users'
);

-- Management chain upward from Frank JuniorSurveyor: Dan (1) -> Carol (2) -> Bob (3) -> Alice (4)
select is(
  (select array_agg(display_name order by level) from api.org_chart_management_chain('e1000000-0000-0000-0000-000000000006')),
  array['Dan SeniorSurveyor', 'Carol StationMgr', 'Bob AreaMgr', 'Alice MD'],
  'api.org_chart_management_chain traverses upward reporting chain'
);

-- Downward reports from Carol StationMgr (all vs max_depth=1)
select is(
  (select count(*) from api.org_chart_reports('e1000000-0000-0000-0000-000000000003', null)),
  3::bigint,
  'api.org_chart_reports returns direct and indirect reports'
);
select is(
  (select count(*) from api.org_chart_reports('e1000000-0000-0000-0000-000000000003', 1)),
  2::bigint,
  'api.org_chart_reports respects p_max_depth = 1'
);

-- Peers of Dan SeniorSurveyor (Eve Coordinator, excluding self)
select is(
  (select array_agg(display_name) from api.org_chart_peers('e1000000-0000-0000-0000-000000000004')),
  array['Eve Coordinator'],
  'api.org_chart_peers returns colleagues sharing the same manager'
);
select is(
  (select count(*) from api.org_chart_peers('e1000000-0000-0000-0000-000000000001')),
  0::bigint,
  'api.org_chart_peers returns 0 rows for root user with no manager'
);

-- Unified MS Teams org chart slice for Dan SeniorSurveyor:
-- chain: Carol (-1), Bob (-2), Alice (-3); self: Dan (0); peer: Eve (0); direct_report: Frank (1)
select is(
  (select count(*) from api.org_chart_for_user('e1000000-0000-0000-0000-000000000004')),
  6::bigint,
  'api.org_chart_for_user returns full Teams org chart slice (chain + self + peers + direct reports)'
);
select is(
  (select count(*) from api.org_chart_for_user(null) where relation = 'self' and user_id = 'e1000000-0000-0000-0000-000000000006'),
  1::bigint,
  'api.org_chart_for_user defaults to caller uid when p_user_id is null'
);

reset role;

-- 4. Parent path cascade trigger test
update core.org_unit set code = 'CN-E-RO' where code = 'CN-EAST-RO';
select is(
  (select path::text from core.org_unit where code = 'SHA'),
  'HO.CN_E_RO.SHA',
  'updating parent org_unit code cascades ltree path to child stations'
);

-- 5. Security boundary checks: ext_user and web_anon are denied
set local role ext_user;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'e1000000-0000-0000-0000-000000000008',
  'role', 'ext_user'
)::text, true);
select throws_ok($$select * from api.org_unit_hierarchy limit 1$$, '42501', null, 'ext_user cannot read api.org_unit_hierarchy');
select throws_ok($$select * from api.org_chart_nodes limit 1$$, '42501', null, 'ext_user cannot read api.org_chart_nodes');
select throws_ok($$select * from api.org_chart_for_user('e1000000-0000-0000-0000-000000000004')$$, '42501', null, 'ext_user cannot call api.org_chart_for_user');
reset role;

set local role web_anon;
select set_config('request.jwt.claims', jsonb_build_object('role', 'web_anon')::text, true);
select throws_ok($$select * from api.org_chart_nodes limit 1$$, '42501', null, 'web_anon cannot read api.org_chart_nodes');
select throws_ok($$select * from api.org_chart_management_chain('e1000000-0000-0000-0000-000000000006')$$, '42501', null, 'web_anon cannot call api.org_chart_management_chain');
reset role;

select * from finish();
rollback;
