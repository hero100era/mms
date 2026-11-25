-- R1.6 rectification: explicit break-glass forbidden-operation matrix and
-- drill evidence. Each db/tests file runs in its own transaction and rolls back.
begin;
set search_path = extensions, public;

select plan(17);

\i db/fixtures/org.sql

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values ('f2222222-0000-0000-0000-000000000001', 'internal', 'Emergency Drill Account',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f2222222-0000-0000-0000-000000000001', 'active');

insert into iam.break_glass_account (user_id, label)
values ('f2222222-0000-0000-0000-000000000001', 'Drill key');

-- A break-glass session is identified by a signed `src` claim whose `bg` window
-- is still open. A forged claim can only cause additional denials.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f2222222-0000-0000-0000-000000000001',
  'role', 'int_sysadmin',
  'src', 'break_glass',
  'bg', (extract(epoch from now() + interval '1 hour'))::bigint
)::text, false);

-- 1. The matrix is explicit and covers the R1.6 list.
select is(
  (select count(*) from iam.break_glass_forbidden_action
    where action_code in (
      'hr.position.set', 'survey.report.release', 'survey.report.countersign',
      'audit_trail.report.release', 'billing.credit_note.approve', 'certificate.issue',
      'certificate.sign', 'report.sign', 'survey.conclude', 'audit_trail.conclude',
      'qualification.approve', 'financial.approval'
    )),
  12::bigint,
  'the break-glass forbidden-operations matrix enumerates the R1.6 list'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'iam.break_glass_forbidden_action'::regclass),
  'the forbidden-actions table has RLS enabled'
);

-- 2. Regulated operations are refused for a break-glass caller.
select throws_ok(
  $$ select private.assert_not_break_glass('hr.position.set') $$,
  '42501', 'break_glass_forbidden_operation',
  'break-glass cannot make an HR decision'
);
select throws_ok(
  $$ select private.assert_not_break_glass('certificate.sign') $$,
  '42501', 'break_glass_forbidden_operation',
  'break-glass cannot sign a certificate (R9 reserved code)'
);
select throws_ok(
  $$ select private.assert_authority('hr.position.set') $$,
  '42501', 'break_glass_forbidden_operation',
  'assert_authority enforces the matrix before the position lookup'
);
select throws_ok(
  $$ select private.assert_authority('billing.credit_note.approve', 100) $$,
  '42501', 'break_glass_forbidden_operation',
  'break-glass cannot perform a financial approval'
);

select ok(
  (select exists (select 1 from audit_trail.event_type where code = 'authz.denied.break_glass_forbidden')),
  'the forbidden-operation denial has a registered audit event type'
);

-- 3. Platform administration remains available.
select lives_ok(
  $$ select private.assert_not_break_glass('org.unit.create') $$,
  'break-glass may still perform platform administration'
);

-- 4. An ordinary caller is unaffected by the matrix.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f2222222-0000-0000-0000-000000000001',
  'role', 'int_sysadmin'
)::text, false);
select lives_ok(
  $$ select private.assert_not_break_glass('hr.position.set') $$,
  'a non-break-glass caller is not affected by the matrix'
);

-- 5. Drill evidence is recorded, not merely read.
select lives_ok(
  $$ select auth.break_glass_drill_record(
       'f2222222-0000-0000-0000-000000000001', 'ops@example.com', 'passed',
       '{"runbook":"docs/runbooks/break-glass.md","check":"restore"}'::jsonb) $$,
  'a completed drill can be recorded'
);
select ok(
  (select last_drill_at is not null from iam.break_glass_account
    where user_id = 'f2222222-0000-0000-0000-000000000001'),
  'recording a drill updates last_drill_at'
);
select is(
  (select count(*) from audit_trail.event where event_type = 'auth.breakglass.drill_recorded'),
  1::bigint,
  'the drill produces a sealed evidence event'
);
select is(
  (select detail ->> 'outcome' from audit_trail.event where event_type = 'auth.breakglass.drill_recorded'),
  'passed',
  'the evidence event records the outcome'
);
select ok(
  (select not exists (
     select 1 from auth.break_glass_drill_overdue()
      where user_id = 'f2222222-0000-0000-0000-000000000001')),
  'a freshly drilled account is no longer reported as overdue'
);

-- 6. Rejected drill inputs.
select throws_ok(
  $$ select auth.break_glass_drill_record('f2222222-0000-0000-0000-000000000001', 'ops@example.com', 'maybe') $$,
  '22023', 'invalid_drill_outcome', 'an unrecognised drill outcome is rejected'
);
select throws_ok(
  $$ select auth.break_glass_drill_record('f2222222-0000-0000-0000-000000000001', '  ', 'passed') $$,
  '22023', 'operator_required', 'a drill without an operator is rejected'
);
select throws_ok(
  $$ select auth.break_glass_drill_record('f2222222-0000-0000-0000-000000000009', 'ops@example.com', 'passed') $$,
  '22023', 'break_glass_account_not_found', 'a drill for an unknown account is rejected'
);

select * from finish();
rollback;
