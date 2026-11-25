-- Schemas and extensions. The schema list must match db/schemas.txt and the
-- folders under db/src. `extensions` and `public` are deliberately not
-- managed by pgschema.

create schema if not exists extensions authorization mms_owner;
create schema if not exists private authorization mms_owner;
create schema if not exists core authorization mms_owner;
create schema if not exists party authorization mms_owner;
create schema if not exists iam authorization mms_owner;
create schema if not exists audit_trail authorization mms_owner;
create schema if not exists auth authorization mms_owner;
create schema if not exists fleet authorization mms_owner;
create schema if not exists survey authorization mms_owner;
create schema if not exists qual authorization mms_owner;
create schema if not exists api authorization mms_owner;

create extension if not exists btree_gist with schema extensions;

-- pgcrypto backs the TOTP verifier for external users (H-09). The second factor
-- is checked inside the database so the shared secret never reaches the BFF; the
-- verification function is the only caller of hmac().
create extension if not exists pgcrypto with schema extensions;

create extension if not exists ltree with schema extensions;

-- pgTAP is a development/CI dependency. Production images do not ship it, so a
-- missing extension is a notice rather than a bootstrap failure. Two SQLSTATEs
-- are tolerated, matching pgaudit below: `undefined_file` when the extension
-- control file is absent, and `feature_not_supported` when it is installed but
-- cannot be loaded. `db/tests/bootstrap.sql` still asserts pgtap is present, so
-- a genuinely broken dev/CI environment fails the database gate rather than
-- silently skipping.
do $$
begin
  create extension if not exists pgtap with schema extensions;
exception
  when undefined_file or feature_not_supported then
    raise notice 'pgtap is not installed; skipping (expected outside dev/CI)';
end
$$;

-- pgaudit provides DDL and statement audit trails (H-02).
do $$
begin
  create extension if not exists pgaudit with schema extensions;
exception
  when undefined_file then
    raise notice 'pgaudit is not installed; skipping (available on supported image)';
  when feature_not_supported then
    raise notice 'pgaudit must be loaded via shared_preload_libraries; skipping';
end
$$;

revoke all on schema public from public;
grant usage on schema extensions to public;
