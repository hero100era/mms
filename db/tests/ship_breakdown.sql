begin;
set search_path = extensions, public;

select plan(13);

-- 1. Schema & structure checks
select has_table('fleet', 'ship_breakdown_node_particular', 'fleet.ship_breakdown_node_particular exists');
select has_column('fleet', 'ship_breakdown_node_particular', 'attr_value', 'attr_value column exists');
select col_is_pk('fleet', 'ship_breakdown_node_particular', 'id', 'id is primary key');

-- 2. Fixture setup (two orgs, two ships, template particular, breakdown + nodes)
insert into party.organization (id, name, org_type, status) values
  ('f1000000-0000-0000-0000-000000000001', 'Alpha Shipping', 'company', 'active'),
  ('f1000000-0000-0000-0000-000000000002', 'Beta Maritime', 'company', 'active');

insert into iam.app_user (id, kind, display_name, email, status) values
  ('f1000000-0000-0000-0000-000000000011', 'external', 'Alpha User', 'alpha.sbn@example.com', 'active'),
  ('f1000000-0000-0000-0000-000000000012', 'external', 'Beta User', 'beta.sbn@example.com', 'active');

insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by) values
  ('f1000000-0000-0000-0000-000000000011', 'external', 'f1000000-0000-0000-0000-000000000001', 'viewer', 'f1000000-0000-0000-0000-000000000011'),
  ('f1000000-0000-0000-0000-000000000012', 'external', 'f1000000-0000-0000-0000-000000000002', 'viewer', 'f1000000-0000-0000-0000-000000000012');

insert into fleet.ship (id, imo_number, name, type_iacs, type_mms, flag_code, status) values
  ('f1000000-0000-0000-0000-000000000101', '9800001', 'MV Alpha', 'BC', 'BC', 'PA', 'in_service'),
  ('f1000000-0000-0000-0000-000000000102', '9800002', 'MV Beta', 'BC', 'BC', 'PA', 'in_service');

insert into fleet.ship_party (ship_id, org_id, party_role, valid) values
  ('f1000000-0000-0000-0000-000000000101', 'f1000000-0000-0000-0000-000000000001', 'registered_owner', tstzrange(now() - interval '1 day', null)),
  ('f1000000-0000-0000-0000-000000000102', 'f1000000-0000-0000-0000-000000000002', 'registered_owner', tstzrange(now() - interval '1 day', null));

with tmpl as (
  insert into core.breakdown_template (code, name) values ('TMPL-SBNP', 'Test Template') returning id
),
tnode as (
  insert into core.breakdown_template_node (template_id, code, name)
  select id, 'MAIN-ENG', 'Main Engine' from tmpl returning id
),
tpart as (
  insert into core.breakdown_template_node_particular (template_node_id, attr_key, attr_title, data_type, unit)
  select id, 'MCR_KW', 'Maximum Continuous Rating', 'decimal', 'kW' from tnode returning id
),
sb1 as (
  insert into fleet.ship_breakdown (ship_id, name) values ('f1000000-0000-0000-0000-000000000101', 'Alpha Breakdown') returning id
),
sb2 as (
  insert into fleet.ship_breakdown (ship_id, name) values ('f1000000-0000-0000-0000-000000000102', 'Beta Breakdown') returning id
),
sbn1 as (
  insert into fleet.ship_breakdown_node (ship_breakdown_id, code, name)
  select id, 'ME-01', 'Main Engine 1' from sb1 returning id
),
sbn2 as (
  insert into fleet.ship_breakdown_node (ship_breakdown_id, code, name)
  select id, 'ME-01', 'Main Engine 1' from sb2 returning id
)
insert into fleet.ship_breakdown_node_particular (ship_breakdown_node_id, template_particular_id, attr_key, attr_title, attr_value, data_type, unit)
select sbn1.id, tpart.id, 'MCR_KW', 'Maximum Continuous Rating', '12500', 'decimal'::core.data_type_enum, 'kW' from sbn1, tpart
union all
select sbn2.id, tpart.id, 'MCR_KW', 'Maximum Continuous Rating', '9800', 'decimal'::core.data_type_enum, 'kW' from sbn2, tpart;

-- 3. Default data_type & unique constraint uq_snode_attr
insert into fleet.ship_breakdown_node_particular (ship_breakdown_node_id, attr_key, attr_title, attr_value)
select id, 'MAKER', 'Manufacturer', 'MAN Energy'
  from fleet.ship_breakdown_node where name = 'Main Engine 1' limit 1;

select is(
  (select data_type::text from fleet.ship_breakdown_node_particular where attr_key = 'MAKER' limit 1),
  'text',
  'data_type defaults to text'
);

select throws_ok(
  $$insert into fleet.ship_breakdown_node_particular (ship_breakdown_node_id, attr_key, attr_title)
    select ship_breakdown_node_id, 'MCR_KW', 'Duplicate'
      from fleet.ship_breakdown_node_particular where attr_key = 'MCR_KW' limit 1$$,
  '23505', null, 'uq_snode_attr prevents duplicate attr_key per ship_breakdown_node'
);

-- 4. Audit capture trigger fires on insert and omits attr_key per 030_audit_exclusions.sql
select ok(
  exists (
    select 1 from audit_trail.change_log
     where schema_name = 'fleet' and table_name = 'ship_breakdown_node_particular' and op = 'I'
  ),
  'audit_capture records insert on fleet.ship_breakdown_node_particular'
);
select is(
  (select (new_row ? 'attr_key') from audit_trail.change_log
    where schema_name = 'fleet' and table_name = 'ship_breakdown_node_particular' and op = 'I' limit 1),
  false,
  'audit_capture omits attr_key per audit_trail.excluded_column'
);

-- 5. RLS: internal staff sees all, ext_user sees only own ship, web_anon denied
set local role int_viewer;
select set_config('request.jwt.claims', jsonb_build_object('role', 'int_viewer')::text, true);
select is(
  (select count(*) from fleet.ship_breakdown_node_particular where attr_key = 'MCR_KW'),
  2::bigint,
  'internal staff reads all ship_breakdown_node_particular rows'
);
reset role;

set local role ext_user;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f1000000-0000-0000-0000-000000000011',
  'role', 'ext_user'
)::text, true);
select is(
  (select count(*) from fleet.ship_breakdown_node_particular where attr_key = 'MCR_KW'),
  1::bigint,
  'ext_user reads only particulars belonging to their own affiliated ship'
);
select is(
  (select attr_value from fleet.ship_breakdown_node_particular where attr_key = 'MCR_KW'),
  '12500',
  'ext_user sees Alpha ship particular value and not Beta ship value'
);
reset role;

set local role web_anon;
select throws_ok(
  $$select * from fleet.ship_breakdown_node_particular limit 1$$,
  '42501', null, 'web_anon cannot select from fleet.ship_breakdown_node_particular'
);
reset role;

-- 6. ON DELETE SET NULL for template_particular_id and ON DELETE CASCADE for ship_breakdown_node_id
delete from core.breakdown_template where code = 'TMPL-SBNP';
select is(
  (select count(*) from fleet.ship_breakdown_node_particular where attr_key = 'MCR_KW' and template_particular_id is null),
  2::bigint,
  'deleting template particular sets template_particular_id to NULL without deleting ship particulars'
);

delete from fleet.ship_breakdown where ship_id = 'f1000000-0000-0000-0000-000000000101';
select is(
  (select count(*) from fleet.ship_breakdown_node_particular where attr_key = 'MCR_KW'),
  1::bigint,
  'deleting ship_breakdown cascades through ship_breakdown_node to ship_breakdown_node_particular'
);

select * from finish();
rollback;
