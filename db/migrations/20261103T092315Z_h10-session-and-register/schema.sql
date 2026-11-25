-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION resolve_entra(
    p_tid uuid,
    p_oid uuid,
    p_upn text,
    p_name text,
    p_app_roles text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_config auth.config;
  v_user iam.app_user;
  v_roles jsonb;
begin
  select * into v_config from auth.config where singleton;
  if v_config.entra_tenant_id is null then
    raise exception 'entra_tenant_not_configured' using errcode = '42501';
  end if;
  if p_tid is null or p_oid is null or p_tid <> v_config.entra_tenant_id then
    raise exception 'foreign_tenant' using errcode = '42501';
  end if;
  if not coalesce(p_app_roles, '{}') @> array[v_config.entra_app_role] then
    raise exception 'mms_user_role_required' using errcode = '42501';
  end if;
  if coalesce(p_app_roles, '{}') && array['Guest', 'MMS.Guest'] then
    raise exception 'guest_denied' using errcode = '42501';
  end if;

  insert into iam.app_user (kind, display_name, email, status, entra_tenant_id, entra_object_id)
  values (
    'internal',
    coalesce(nullif(trim(p_name), ''), coalesce(p_upn, p_oid::text)),
    case when p_upn like '%@%' then lower(p_upn) end,
    'active',
    p_tid,
    p_oid
  )
  on conflict (entra_tenant_id, entra_object_id) do update
    set display_name = excluded.display_name,
        email = coalesce(excluded.email, iam.app_user.email),
        status = case when iam.app_user.status = 'deactivated' then 'active' else iam.app_user.status end
  returning * into v_user;

  select coalesce(jsonb_agg(distinct a.db_role order by a.db_role), '[]'::jsonb)
    into v_roles
    from iam.role_assignment a
   where a.user_id = v_user.id
     and a.revoked_at is null
     and a.valid @> now();

  return jsonb_build_object(
    'user_id', v_user.id,
    'status', v_user.status,
    'assignable_roles', v_roles,
    -- H-10: the BFF routes a break-glass identity to the reason form instead of the
    -- role chooser. Dormant means no assignable roles, which alone would look like
    -- "no access" and strand the account that exists to fix that.
    'break_glass', exists (
      select 1 from iam.break_glass_account b
       where b.user_id = v_user.id and b.enabled
    )
  );
end;
$$;

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
  -- H-10: a break-glass account signs in while dormant, so it reaches the reason
  -- form and nothing else. The session is short-lived by construction (30 min idle,
  -- 4 h absolute, matching the longest activation window) and grants no authority:
  -- the account holds no assignment until `auth.break_glass_activate` runs, and
  -- `private.pre_request` checks exactly that, so PostgREST refuses every call
  -- in the meantime.
  if exists (select 1 from iam.break_glass_account b where b.user_id = p_user_id) then
    if p_active_role <> 'int_sysadmin' then
      raise exception 'break_glass_requires_sysadmin_session' using errcode = '42501';
    end if;
    v_idle := interval '30 minutes';
    v_absolute := interval '4 hours';
  elsif v_user.kind = 'external' then
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

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION break_glass_register(
    p_user_id uuid,
    p_label text,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
begin
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_label is null or btrim(p_label) = '' then
    raise exception 'label_required' using errcode = '22023';
  end if;

  select * into v_user from iam.app_user where id = p_user_id;
  if not found then
    raise exception 'unknown_user' using errcode = '22023';
  end if;
  if v_user.kind <> 'internal' then
    raise exception 'break_glass_requires_internal_user' using errcode = '22023';
  end if;
  if v_user.status <> 'active' then
    raise exception 'break_glass_requires_active_user' using errcode = '22023';
  end if;
  if exists (
    select 1 from iam.staff_position p
     where p.user_id = p_user_id and p.valid @> now()
  ) then
    raise exception 'break_glass_account_holds_position' using errcode = '23514';
  end if;
  if exists (select 1 from iam.break_glass_account b where b.user_id = p_user_id) then
    raise exception 'already_break_glass_account' using errcode = '23505';
  end if;

  perform private.set_change_context(p_reason);

  insert into iam.break_glass_account (user_id, label)
  values (p_user_id, btrim(p_label));

  perform private.emit_event(
    'auth.breakglass.registered', 'success', 'user', p_user_id, null, p_reason,
    jsonb_build_object('label', btrim(p_label))
  );
end;
$$;

REVOKE EXECUTE ON FUNCTION break_glass_register(p_user_id uuid, p_label text, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION break_glass_register(p_user_id uuid, p_label text, p_reason text) TO int_sysadmin;
