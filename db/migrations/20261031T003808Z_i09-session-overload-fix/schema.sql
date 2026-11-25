-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

GRANT EXECUTE ON FUNCTION session_revoke(p_sid uuid, p_reason text) TO PUBLIC;

REVOKE EXECUTE ON FUNCTION session_revoke(p_sid uuid, p_reason text) FROM auth_gateway;

DROP FUNCTION IF EXISTS session_revoke(uuid, text);

CREATE OR REPLACE FUNCTION session_revoke_reason(
    p_sid uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from iam.session where id = p_sid and revoked_at is null;
  update iam.session
     set revoked_at = now(), revoke_reason = coalesce(p_reason, 'logout')
   where id = p_sid and revoked_at is null;
  if v_user_id is not null and coalesce(p_reason, 'logout') = 'logout' then
    perform auth.log_event('auth.logout', 'success', v_user_id, jsonb_build_object('session_id', p_sid));
  end if;
end;
$$;

REVOKE EXECUTE ON FUNCTION session_revoke_reason(p_sid uuid, p_reason text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION session_revoke(
    p_sid uuid
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  select auth.session_revoke_reason(p_sid, 'logout');
$$;

GRANT EXECUTE ON FUNCTION session_revoke_reason(p_sid uuid, p_reason text) TO auth_gateway;
