-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION user_roles(
    p_user_id uuid
)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select coalesce(array_agg(distinct ra.db_role order by ra.db_role), '{}'::text[])
  from iam.role_assignment ra
  where ra.user_id = p_user_id
    and ra.revoked_at is null;
$$;

REVOKE EXECUTE ON FUNCTION user_roles(p_user_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION user_roles(p_user_id uuid) TO auth_gateway;
