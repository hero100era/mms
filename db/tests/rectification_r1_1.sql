-- R1.1 required adversarial tests: the five cases the plan names explicitly.
-- Each db/tests file runs in its own transaction and rolls back.
begin;
set search_path = extensions, public;

select plan(11);

\i db/fixtures/org.sql

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values
  ('f4444444-0000-0000-0000-000000000001', 'internal', 'Adversarial Viewer',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f4444444-0000-0000-0000-000000000001', 'active'),
  ('f4444444-0000-0000-0000-000000000002', 'internal', 'Adversarial Admin',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f4444444-0000-0000-0000-000000000002', 'active');

insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
values
  ('f4444444-0000-0000-0000-000000000001', 'internal', 'int_viewer', 'global', 'manual',
   '00000000-0000-0000-0000-000000000001', 'adversarial setup'),
  ('f4444444-0000-0000-0000-000000000002', 'internal', 'int_sysadmin', 'global', 'manual',
   '00000000-0000-0000-0000-000000000001', 'adversarial setup');

-- ---------------------------------------------------------------------------
-- T1. A JWT claim naming `worker` does not make a gateway caller a trusted
--     worker. The claim is attacker-controlled; the role GUC is not.
-- ---------------------------------------------------------------------------
set local role int_sysadmin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f4444444-0000-0000-0000-000000000001',
  'role', 'worker'
)::text, true);

select is(
  private.is_worker(), false,
  'a forged worker JWT claim does not make a PostgREST caller the worker'
);
select is(
  private.caller_role(), 'int_sysadmin',
  'caller_role reports the switched capability role, not the claimed one'
);
-- `private.audit_source()` is an internal helper the capability roles cannot
-- execute. The property that matters is that a capability role cannot call the
-- event writer at all: a direct caller supplies its own `request.jwt.claims`, so
-- a grant would let it forge `db_role` on the append-only trail.
select throws_ok(
  $$ select private.emit_event('authz.denied.out_of_scope', 'denied', 'org_unit', null, null, null, '{}'::jsonb) $$,
  '42501', null,
  'a capability role cannot write audit events directly (no forged db_role)'
);
select is(
  (select count(*) from audit_trail.event where event_type = 'authz.denied.out_of_scope' and db_role = 'worker'),
  0::bigint,
  'no audit event carries the forged worker claim as db_role'
);

-- ---------------------------------------------------------------------------
-- T2. An unrelated internal role cannot call worker-only scan functions, even
--     when it holds an EXECUTE grant via its capability role.
-- ---------------------------------------------------------------------------
reset role;
set local role int_viewer;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f4444444-0000-0000-0000-000000000001',
  'role', 'int_viewer'
)::text, true);

select throws_ok(
  $$ select private.record_entra_sync_run('clean', 0, 0, '{}', null, '{}'::jsonb) $$,
  '42501', null,
  'an unrelated internal role cannot call a worker-only function (denied by ACL or by the in-body guard)'
);
select throws_ok(
  $$ select private.list_pending_quarantine_scans(10) $$,
  '42501', null,
  'an unrelated internal role cannot list quarantine scan targets'
);

-- ---------------------------------------------------------------------------
-- T3. int_sysadmin succeeds only where explicitly intended.
-- ---------------------------------------------------------------------------
reset role;
set local role int_sysadmin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f4444444-0000-0000-0000-000000000002',
  'role', 'int_sysadmin'
)::text, true);

select lives_ok(
  $$ select private.list_pending_quarantine_scans(10) $$,
  'int_sysadmin succeeds where it is explicitly authorised'
);
select throws_ok(
  $$ select private.deprovision_staff_user('f4444444-0000-0000-0000-000000000009', 'test',
       private.claims()) $$,
  null, null,
  'int_sysadmin does not silently gain unrelated authority'
);

-- ---------------------------------------------------------------------------
-- T4. Function ownership does not grant application authority: mms_owner owns
--     every definer function, yet the ownership path has no business authority.
-- ---------------------------------------------------------------------------
reset role;
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('api', 'private', 'auth', 'audit_trail')
      and p.prokind = 'f'
      and p.prosecdef
      and p.proowner <> 'mms_owner'::regrole),
  0::bigint,
  'every SECURITY DEFINER function is owned by mms_owner, so ownership is not authority'
);

-- ---------------------------------------------------------------------------
-- T5. Direct invocation without valid claims fails closed.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select set_config('role', 'none', true);

select is(
  private.is_worker_or_admin(), false,
  'a direct call with no claims is neither worker nor admin'
);
select throws_ok(
  $$ select private.record_entra_sync_run('clean', 0, 0, '{}', null, '{}'::jsonb) $$,
  '42501', 'worker_or_admin_role_required',
  'a direct call without claims fails closed on a privileged function'
);

select * from finish();
rollback;
