-- R2.5: explicit [) temporal bounds and subject-row locking.
begin;
set search_path = extensions, public;

select plan(7);

\i db/fixtures/org.sql

select is(
  (select count(*) from pg_constraint
    where contype = 'c' and conname like '%_valid_bounds_ck'
      and conrelid in (
        'iam.staff_position'::regclass,
        'iam.role_assignment'::regclass,
        'iam.org_membership'::regclass,
        'core.org_unit_coverage'::regclass
      )),
  4::bigint,
  'all four temporal tables carry an explicit [) bounds CHECK'
);

select ok(
  (select pg_get_constraintdef(oid) like '%lower_inc(valid)%'
     from pg_constraint
    where conname = 'staff_position_valid_bounds_ck'),
  'staff_position bounds CHECK requires lower_inc'
);
select ok(
  (select pg_get_constraintdef(oid) ~ 'isempty\(valid\).*lower_inc\(valid\).*NOT upper_inc\(valid\)'
     from pg_constraint
    where conname = 'org_unit_coverage_valid_bounds_ck'),
  'org_unit_coverage bounds CHECK forbids upper_inc on a non-empty range'
);

-- A closed-upper range must be rejected even when it does not overlap anything.
select throws_ok(
  $$ insert into core.org_unit_coverage
       (unit_id, covered_unit_id, valid, set_by, reason)
     select (select id from core.org_unit where code = 'HO'),
            (select id from core.org_unit where code = 'SHA'),
            tstzrange(now(), now() + interval '1 day', '[]'),
            '00000000-0000-0000-0000-000000000001', 'closed range test' $$,
  '23514',
  null,
  'a [] range is rejected by the [) bounds CHECK'
);

-- The canonical half-open form is accepted.
select lives_ok(
  $$ insert into core.org_unit_coverage
       (unit_id, covered_unit_id, valid, set_by, reason)
     select (select id from core.org_unit where code = 'HO'),
            (select id from core.org_unit where code = 'SZX'),
            tstzrange(now(), now() + interval '1 day', '[)'),
            '00000000-0000-0000-0000-000000000001', 'half-open range test' $$,
  'a [) range is accepted'
);

select ok(
  (select bool_and(lower_inc(valid) and not upper_inc(valid))
     from core.org_unit_coverage
    where reason = 'half-open range test'),
  'stored coverage ranges are half-open'
);

-- Deprovisioning closes a future-dated period that never started by setting
-- the range to 'empty'; that degenerate value must remain legal.
select lives_ok(
  $$ insert into core.org_unit_coverage
       (unit_id, covered_unit_id, valid, set_by, reason)
     select (select id from core.org_unit where code = 'HO'),
            (select id from core.org_unit where code = 'XMN'),
            'empty'::tstzrange,
            '00000000-0000-0000-0000-000000000001', 'empty range test' $$,
  'an empty range is accepted (deprovisioning closes a never-started period)'
);

select * from finish();
rollback;
