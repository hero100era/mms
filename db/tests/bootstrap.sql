begin;

set search_path = extensions, public;

select plan(21);

-- Capability roles exist, cannot log in, and cannot bypass RLS.
select ok(
  bool_and(
    exists (
      select 1
      from pg_roles r
      where r.rolname = c.role_name
        and not r.rolcanlogin
        and not r.rolbypassrls
        and not r.rolsuper
    )
  ),
  'all capability roles exist as NOLOGIN, non-superuser, NOBYPASSRLS roles'
)
from (
  values
    ('web_anon'),
    ('ext_user'),
    ('int_viewer'),
    ('int_surveyor'),
    ('int_auditor'),
    ('int_coordinator'),
    ('int_manager'),
    ('int_compliance'),
    ('int_hr'),
    ('int_finance'),
    ('int_sysadmin')
) as c(role_name);

-- authenticator is a member of every capability role.
select ok(
  bool_and(pg_has_role('authenticator', c.role_name, 'MEMBER')),
  'authenticator is a member of every capability role'
)
from (
  values
    ('web_anon'),
    ('ext_user'),
    ('int_viewer'),
    ('int_surveyor'),
    ('int_auditor'),
    ('int_coordinator'),
    ('int_manager'),
    ('int_compliance'),
    ('int_hr'),
    ('int_finance'),
    ('int_sysadmin')
) as c(role_name);

-- No capability role is a member of another.
select is(
  (
    select count(*)::integer
    from pg_auth_members m
    join pg_roles member on member.oid = m.member
    join pg_roles granted on granted.oid = m.roleid
    where member.rolname in (
      'web_anon', 'ext_user', 'int_viewer', 'int_surveyor', 'int_auditor',
      'int_coordinator', 'int_manager', 'int_compliance', 'int_hr',
      'int_finance', 'int_sysadmin'
    )
      and granted.rolname in (
        'web_anon', 'ext_user', 'int_viewer', 'int_surveyor', 'int_auditor',
        'int_coordinator', 'int_manager', 'int_compliance', 'int_hr',
        'int_finance', 'int_sysadmin'
      )
  ),
  0,
  'no capability role is a member of another capability role'
);

-- mms_owner is a member of nothing.
select is(
  (
    select count(*)::integer
    from pg_auth_members m
    join pg_roles member on member.oid = m.member
    where member.rolname = 'mms_owner'
  ),
  0,
  'mms_owner is a member of nothing'
);

select ok(pg_has_role('migrator', 'mms_owner', 'MEMBER'), 'migrator is a member of mms_owner');

select ok(
  not pg_has_role('authenticator', 'mms_owner', 'MEMBER')
    and not pg_has_role('authenticator', 'migrator', 'MEMBER')
    and not pg_has_role('authenticator', 'auth_gateway', 'MEMBER')
    and not pg_has_role('authenticator', 'worker', 'MEMBER')
    and not pg_has_role('authenticator', 'audit_sealer', 'MEMBER'),
  'authenticator cannot assume an owner or login role'
);

select is(
  (
    select count(*)::integer
    from pg_auth_members m
    join pg_roles member on member.oid = m.member
    where member.rolname in ('auth_gateway', 'worker', 'audit_sealer')
  ),
  0,
  'auth_gateway, worker and audit_sealer are members of nothing'
);

select ok(
  not exists (
    select 1
    from pg_roles
    where rolname not like 'pg\_%'
      and rolname <> 'postgres'
      and rolbypassrls
  ),
  'no application role has BYPASSRLS'
);

select ok(
  bool_and(
    exists (
      select 1
      from pg_namespace n
      where n.nspname = s.schema_name
        and pg_get_userbyid(n.nspowner) = 'mms_owner'
    )
  ),
  'all application schemas are owned by mms_owner'
)
from (
  values ('extensions'), ('private'), ('core'), ('party'), ('iam'), ('audit_trail'), ('auth'), ('fleet'), ('survey'), ('qual'), ('api')
) as s(schema_name);

select ok(
  not exists (
    select 1
    from pg_namespace n,
      aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    where n.nspname = 'public'
      and a.grantee = 0
      and a.privilege_type in ('USAGE', 'CREATE')
  ),
  'public schema grants nothing to PUBLIC'
);

select ok(
  bool_and(has_schema_privilege(c.role_name, 'extensions', 'USAGE')),
  'extensions schema is usable by every capability role'
)
from (
  values
    ('web_anon'), ('ext_user'), ('int_viewer'), ('int_surveyor'), ('int_auditor'),
    ('int_coordinator'), ('int_manager'), ('int_compliance'), ('int_hr'),
    ('int_finance'), ('int_sysadmin')
) as c(role_name);

-- New functions created by mms_owner are not executable by PUBLIC.
set role mms_owner;
create function private._bootstrap_default_privilege_probe()
returns integer
language sql
as 'select 1';
reset role;

select ok(
  not has_function_privilege(
    'web_anon',
    'private._bootstrap_default_privilege_probe()',
    'EXECUTE'
  ),
  'new functions do not grant EXECUTE to PUBLIC by default'
);

drop function private._bootstrap_default_privilege_probe();

select ok(
  bool_and(
    exists (
      select 1
      from pg_roles r
      where r.rolname = s.role_name
        and 'search_path=""' = any (coalesce(r.rolconfig, array[]::text[]))
    )
  ),
  'login roles run with an empty search_path'
)
from (
  values ('mms_owner'), ('migrator'), ('authenticator'), ('auth_gateway'), ('worker'), ('audit_sealer')
) as s(role_name);

select ok(
  'statement_timeout=30s' = any (
    coalesce((select rolconfig from pg_roles where rolname = 'authenticator'), array[]::text[])
  ),
  'authenticator has a statement timeout'
);

select ok(
  'idle_in_transaction_session_timeout=30s' = any (
    coalesce((select rolconfig from pg_roles where rolname = 'authenticator'), array[]::text[])
  ),
  'authenticator has an idle-in-transaction timeout'
);

select ok(
  not exists (
    select 1
    from pg_auth_members m
    join pg_roles member on member.oid = m.member
    join pg_roles granted on granted.oid = m.roleid
    where member.rolname in (
      'web_anon', 'ext_user', 'int_viewer', 'int_surveyor', 'int_auditor',
      'int_coordinator', 'int_manager', 'int_compliance', 'int_hr',
      'int_finance', 'int_sysadmin'
    )
      and granted.rolname in ('mms_owner', 'migrator', 'authenticator', 'auth_gateway', 'worker', 'audit_sealer')
  ),
  'no capability role can SET ROLE to an owner or login role'
);

select ok(
  (select count(*) from pg_extension where extname = 'btree_gist') = 1,
  'btree_gist is installed'
);

select ok(
  (select count(*) from pg_extension where extname = 'pgcrypto') = 1,
  'pgcrypto is installed (TOTP verifier)'
);

select ok(
  (select count(*) from pg_extension where extname = 'pgtap') = 1,
  'pgtap is installed in the test environment'
);

select is(
  (select count(*)::integer from pg_namespace where nspname in ('private', 'core', 'party', 'iam', 'audit_trail', 'auth', 'fleet', 'survey', 'qual', 'api', 'extensions')),
  11,
  'all application schemas exist'
);

select ok(
  'pgaudit.log=ddl, role' = any (
    coalesce((select rolconfig from pg_roles where rolname = 'migrator'), array[]::text[])
  ),
  'migrator has pgaudit.log=ddl, role'
);

select * from finish();

rollback;
