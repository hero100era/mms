-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION staff_assignments(
    p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, user_id uuid, display_name text, db_role text, scope_type text, scope_unit_id uuid, source text, valid tstzrange, revoked_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select a.id, a.user_id, u.display_name, a.db_role, a.scope_type, a.scope_unit_id,
         a.source, a.valid, a.revoked_at
    from iam.role_assignment a
    join iam.app_user u on u.id = a.user_id
   where p_user_id is null or a.user_id = p_user_id
   order by u.display_name, a.db_role;
$$;

CREATE OR REPLACE FUNCTION staff_directory()
RETURNS TABLE(id uuid, display_name text, kind text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select u.id, u.display_name, u.kind, u.status
    from iam.app_user u
   where u.kind = 'internal'
   order by u.display_name;
$$;

REVOKE EXECUTE ON FUNCTION staff_assignments(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION staff_directory() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION staff_assignments(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION staff_assignments(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION staff_directory() TO int_hr;

GRANT EXECUTE ON FUNCTION staff_directory() TO int_sysadmin;
