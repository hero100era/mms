-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION pre_request()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c jsonb := private.claims();
  r text := c ->> 'role';
  k text;
begin
  select kind into k from iam.db_role where role_name = r;
  if k is null then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  if k = 'anon' then
    if c ? 'sub' then
      raise exception using errcode = 'PT401', message = 'anon_with_subject';
    end if;
    return;
  end if;
  if not exists (
    select 1
      from iam.session s
      join iam.app_user u on u.id = s.user_id
     where s.id = (c ->> 'sid')::uuid
       and s.user_id = (c ->> 'sub')::uuid
       and s.active_role = r
       and s.revoked_at is null
       and now() < s.idle_expires_at
       and now() < s.expires_at
       and u.status = 'active'
       and ((k = 'external' and u.kind = 'external')
         or (k = 'internal' and u.kind = 'internal' and exists (
               select 1 from iam.role_assignment a
                where a.user_id = u.id
                  and a.db_role = r
                  and a.revoked_at is null
                  and a.valid @> now())))
  ) then
    raise exception using errcode = 'PT401', message = 'session_invalid';
  end if;
end;
$$;

REVOKE EXECUTE ON FUNCTION pre_request() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pre_request() TO ext_user;

GRANT EXECUTE ON FUNCTION pre_request() TO int_auditor;

GRANT EXECUTE ON FUNCTION pre_request() TO int_compliance;

GRANT EXECUTE ON FUNCTION pre_request() TO int_coordinator;

GRANT EXECUTE ON FUNCTION pre_request() TO int_finance;

GRANT EXECUTE ON FUNCTION pre_request() TO int_hr;

GRANT EXECUTE ON FUNCTION pre_request() TO int_manager;

GRANT EXECUTE ON FUNCTION pre_request() TO int_surveyor;

GRANT EXECUTE ON FUNCTION pre_request() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION pre_request() TO int_viewer;

GRANT EXECUTE ON FUNCTION pre_request() TO web_anon;
