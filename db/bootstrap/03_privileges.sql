-- Global default privileges. Function EXECUTE is granted to PUBLIC by default
-- in PostgreSQL; revoke it for every object mms_owner creates so a new function
-- is private until its grants.sql says otherwise.

alter default privileges for role mms_owner revoke execute on functions from public;
alter default privileges for role mms_owner revoke all on tables from public;
alter default privileges for role mms_owner revoke all on sequences from public;

-- The public schema is not part of the application surface. The migration
-- runner keeps its ledger there, so mms_owner needs DDL rights.
revoke all on schema public from public;
grant create, usage on schema public to mms_owner;

-- Schema renames and DDL require CREATE privilege on the database for mms_owner.
do $$
begin
  execute format('grant create on database %I to mms_owner', current_database());
end
$$;

-- Capability roles may enter the API and private helper schemas. Domain-schema
-- USAGE is separate: pgschema does not track schema USAGE, so it stays here.
grant usage on schema api, private to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant usage on schema core, party, fleet, survey to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant usage on schema audit_trail to
  int_compliance, int_sysadmin, int_manager, audit_sealer, worker;
grant usage on schema auth to auth_gateway, worker;
grant usage on schema private to web_anon, worker;
grant usage on schema iam to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
-- H-10 S3: the emergency role reaches iam only through the runbook functions in api,
-- which is why it needs USAGE on the schema those functions run their SQL against and
-- nothing else: no SELECT, INSERT, UPDATE or DELETE on any iam table is granted to it.
grant usage on schema iam to mms_emergency;
