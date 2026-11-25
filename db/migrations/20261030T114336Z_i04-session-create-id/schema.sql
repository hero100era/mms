-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

GRANT EXECUTE ON FUNCTION session_create(p_user_id uuid, p_method text, p_active_role text, p_ip inet, p_user_agent text) TO PUBLIC;

REVOKE EXECUTE ON FUNCTION session_create(p_user_id uuid, p_method text, p_active_role text, p_ip inet, p_user_agent text) FROM auth_gateway;

DROP FUNCTION IF EXISTS session_create(uuid, text, text, inet, text);

CREATE OR REPLACE FUNCTION session_create(
    p_user_id uuid,
    p_method text,
    p_active_role text,
    p_ip inet,
    p_user_agent text,
    p_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_session iam.session;
  v_idle interval;
  v_absolute interval;
begin
  select * into v_user from iam.app_user where id = p_user_id;
  if not found or v_user.status <> 'active' or v_user.kind = 'service' then
    raise exception 'user_not_active' using errcode = '42501';
  end if;
  if p_method not in ('entra', 'microsoft', 'google', 'pwd') then
    raise exception 'unknown_auth_method' using errcode = '22023';
  end if;
  if v_user.kind = 'external' then
    if p_active_role <> 'ext_user' then
      raise exception 'external_session_requires_ext_user' using errcode = '42501';
    end if;
    v_idle := interval '30 minutes';
    v_absolute := interval '8 hours';
  else
    if p_active_role = 'ext_user' or not exists (
      select 1 from iam.role_assignment a
       where a.user_id = p_user_id
         and a.db_role = p_active_role
         and a.revoked_at is null
         and a.valid @> now()
    ) then
      raise exception 'role_not_assigned' using errcode = '42501';
    end if;
    v_idle := interval '60 minutes';
    v_absolute := interval '12 hours';
  end if;

  insert into iam.session (
    id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at,
    client_ip, user_agent
  ) values (
    coalesce(p_id, uuidv7()), p_user_id, v_user.kind, p_active_role, p_method,
    now() + v_idle, now() + v_absolute, p_ip, p_user_agent
  )
  returning * into v_session;

  return jsonb_build_object(
    'session_id', v_session.id,
    'user_id', v_session.user_id,
    'user_kind', v_session.user_kind,
    'active_role', v_session.active_role,
    'idle_expires_at', v_session.idle_expires_at,
    'expires_at', v_session.expires_at
  );
end;
$$;

REVOKE EXECUTE ON FUNCTION session_create(p_user_id uuid, p_method text, p_active_role text, p_ip inet, p_user_agent text, p_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION session_create(p_user_id uuid, p_method text, p_active_role text, p_ip inet, p_user_agent text, p_id uuid) TO auth_gateway;
