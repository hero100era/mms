-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION app_user_revoke_sessions()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if new.status in ('suspended', 'deactivated')
     and new.status is distinct from old.status then
    update iam.session
       set revoked_at = now(),
           revoke_reason = 'user_' || new.status
     where user_id = new.id
       and revoked_at is null;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION role_assignment_sod()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if new.revoked_at is null then
    if new.db_role = 'int_sysadmin' then
      if exists (
        select 1 from iam.role_assignment a
         where a.user_id = new.user_id
           and a.id is distinct from new.id
           and a.revoked_at is null
           and a.db_role <> 'int_sysadmin'
      ) then
        raise exception 'int_sysadmin_cannot_combine_with_business_role' using errcode = '23514';
      end if;
    elsif exists (
      select 1 from iam.role_assignment a
       where a.user_id = new.user_id
         and a.id is distinct from new.id
         and a.revoked_at is null
         and a.db_role = 'int_sysadmin'
    ) then
      raise exception 'int_sysadmin_cannot_combine_with_business_role' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

REVOKE EXECUTE ON FUNCTION app_user_revoke_sessions() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION role_assignment_sod() FROM PUBLIC;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE OR REPLACE TRIGGER app_user_revoke_sessions
    AFTER UPDATE OF status ON app_user
    FOR EACH ROW
    EXECUTE FUNCTION private.app_user_revoke_sessions();

CREATE OR REPLACE TRIGGER role_assignment_sod
    BEFORE INSERT OR UPDATE ON role_assignment
    FOR EACH ROW
    EXECUTE FUNCTION private.role_assignment_sod();
