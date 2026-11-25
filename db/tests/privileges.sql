begin;
set search_path = extensions, public;

select plan(5);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('private', 'core', 'party', 'iam', 'audit_trail', 'auth', 'fleet', 'survey', 'qual', 'api')
      and c.relowner <> 'mms_owner'::regrole
  ),
  0::bigint,
  'all relations in managed schemas are owned by mms_owner'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private', 'core', 'party', 'iam', 'audit_trail', 'auth', 'fleet', 'survey', 'qual', 'api')
      and p.proowner <> 'mms_owner'::regrole
  ),
  0::bigint,
  'all functions in managed schemas are owned by mms_owner'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private', 'core', 'party', 'iam', 'audit_trail', 'auth', 'fleet', 'survey', 'qual', 'api')
      and (
        p.proacl is null
        or exists (
          select 1
          from aclexplode(p.proacl) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
        )
      )
  ),
  0::bigint,
  'no function grants EXECUTE to PUBLIC'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('private', 'core', 'party', 'iam', 'audit_trail', 'auth', 'fleet', 'survey', 'qual', 'api')
      and c.relkind = 'v'
      and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%'
  ),
  0::bigint,
  'every view is security_invoker'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind not in ('i', 'I')
      and c.relname not in ('schema_migrations', 'schema_migration_statements')
  ),
  0::bigint,
  'public contains only the migration ledger'
);

select * from finish();
rollback;
