-- Cluster-level roles. pgschema does not manage roles, so this file is
-- idempotent and lives outside the declarative schema.
--
-- Run as a platform administrator (dev/CI: the database superuser).
-- The roles themselves are NOLOGIN except for the login roles.

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'mms_owner',
    'migrator',
    'authenticator',
    'auth_gateway',
    'worker',
    'audit_sealer',
    'web_anon',
    'ext_user',
    'int_viewer',
    'int_surveyor',
    'int_auditor',
    'int_coordinator',
    'int_manager',
    'int_compliance',
    'int_hr',
    'int_finance',
    'int_sysadmin',
    'mms_emergency'
  ]
  loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin noinherit nobypassrls', role_name);
    end if;
  end loop;
end
$$;

alter role mms_owner nologin noinherit nobypassrls;
alter role migrator login noinherit nobypassrls;
alter role authenticator login noinherit nobypassrls;
alter role auth_gateway login noinherit nobypassrls;
alter role worker login noinherit nobypassrls;
alter role audit_sealer login noinherit nobypassrls;

alter role web_anon nologin noinherit nobypassrls;
alter role ext_user nologin noinherit nobypassrls;
alter role int_viewer nologin noinherit nobypassrls;
alter role int_surveyor nologin noinherit nobypassrls;
alter role int_auditor nologin noinherit nobypassrls;
alter role int_coordinator nologin noinherit nobypassrls;
alter role int_manager nologin noinherit nobypassrls;
alter role int_compliance nologin noinherit nobypassrls;
alter role int_hr nologin noinherit nobypassrls;
alter role int_finance nologin noinherit nobypassrls;
alter role int_sysadmin nologin noinherit nobypassrls;

-- H-10 S3: the database-level emergency role. It holds no capability role, so it
-- cannot SET ROLE into one, and it may execute only the fixed runbook functions in
-- db/src/api that are granted to it. Login is DISABLED here; the platform
-- administrator enables it for an incident with
--   alter role mms_emergency login;
-- which pgaudit records under 'role' (H-02) because it is a role-attribute change,
-- not a row write, and so cannot be hidden by anything the application can do.
alter role mms_emergency nologin noinherit nobypassrls;

-- mms_owner owns objects. Only migrator may become it.
grant mms_owner to migrator;

-- authenticator may assume capability roles, but inherits nothing by default.
grant web_anon to authenticator;
grant ext_user to authenticator;
grant int_viewer to authenticator;
grant int_surveyor to authenticator;
grant int_auditor to authenticator;
grant int_coordinator to authenticator;
grant int_manager to authenticator;
grant int_compliance to authenticator;
grant int_hr to authenticator;
grant int_finance to authenticator;
grant int_sysadmin to authenticator;
