-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE TABLE IF NOT EXISTS config (
    singleton boolean DEFAULT true,
    entra_tenant_id uuid,
    entra_app_role text DEFAULT 'MMS.User' NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT config_pkey PRIMARY KEY (singleton),
    CONSTRAINT auth_config_singleton_ck CHECK (singleton)
);

ALTER TABLE config ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION is_throttled(
    p_login_name text,
    p_ip inet,
    p_window interval DEFAULT '00:15:00'::interval,
    p_max_attempts integer DEFAULT 5
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select count(*) >= p_max_attempts
    from iam.login_attempt a
   where a.at > now() - p_window
     and a.outcome = 'failure'
     and (a.login_name = lower(p_login_name) or a.client_ip = p_ip);
$$;

CREATE OR REPLACE FUNCTION link_identity(
    p_sid uuid,
    p_provider text,
    p_issuer text,
    p_subject text,
    p_email text,
    p_tenant_id uuid,
    p_object_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_step_up timestamptz;
begin
  select user_id, nullif(data ->> 'stepUpAt', '')::timestamptz
    into v_user, v_step_up
    from iam.session
   where id = p_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_user is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;
  if v_step_up is null or v_step_up < now() - interval '10 minutes' then
    raise exception 'step_up_required' using errcode = '42501';
  end if;
  if not exists (select 1 from iam.app_user where id = v_user and kind = 'external' and status = 'active') then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  if p_provider not in ('microsoft', 'google') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;
  insert into iam.user_identity (
    user_id, provider, issuer, subject, tenant_id, object_id, email_at_link
  ) values (
    v_user, p_provider, p_issuer, p_subject, p_tenant_id, p_object_id,
    case when p_email like '%@%' then lower(p_email) end
  );
end;
$$;

CREATE OR REPLACE FUNCTION log_event(
    p_event_type text,
    p_outcome text,
    p_subject_id uuid,
    p_detail jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  select private.emit_event(p_event_type, p_outcome, 'user', p_subject_id, null, null, p_detail);
$$;

CREATE OR REPLACE FUNCTION password_lookup(
    p_login_name text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select coalesce(
    (select jsonb_build_object('user_id', u.id, 'hash', c.hash, 'status', u.status)
       from iam.app_user u
       left join iam.password_credential c on c.user_id = u.id
      where u.kind = 'external'
        and u.email = lower(p_login_name)
        and u.status in ('invited', 'active', 'suspended')),
    jsonb_build_object('status', 'unknown')
  );
$$;

CREATE OR REPLACE FUNCTION record_attempt(
    p_login_name text,
    p_ip inet,
    p_outcome text,
    p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  insert into iam.login_attempt (login_name, client_ip, outcome, reason)
  values (lower(p_login_name), p_ip, p_outcome, p_reason);
$$;

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
        email = coalesce(excluded.email, iam.app_user.email)
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
    'assignable_roles', v_roles
  );
end;
$$;

CREATE OR REPLACE FUNCTION resolve_external(
    p_provider text,
    p_issuer text,
    p_subject text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
begin
  if p_provider not in ('microsoft', 'google') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;
  select i.user_id into v_user_id
    from iam.user_identity i
    join iam.app_user u on u.id = i.user_id and u.kind = 'external'
   where i.provider = p_provider
     and i.issuer = p_issuer
     and i.subject = p_subject
     and i.unlinked_at is null
     and u.status = 'active';
  if v_user_id is null then
    return jsonb_build_object('status', 'not_linked');
  end if;
  return jsonb_build_object('status', 'linked', 'user_id', v_user_id);
end;
$$;

CREATE OR REPLACE FUNCTION session_create(
    p_user_id uuid,
    p_method text,
    p_active_role text,
    p_ip inet,
    p_user_agent text
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
    user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at,
    client_ip, user_agent
  ) values (
    p_user_id, v_user.kind, p_active_role, p_method,
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

CREATE OR REPLACE FUNCTION session_read(
    p_sid uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select jsonb_build_object(
    'session_id', s.id,
    'user_id', s.user_id,
    'user_kind', s.user_kind,
    'active_role', s.active_role,
    'auth_method', s.auth_method,
    'data', s.data,
    'created_at', s.created_at,
    'last_seen_at', s.last_seen_at,
    'idle_expires_at', s.idle_expires_at,
    'expires_at', s.expires_at
  )
  from iam.session s
  where s.id = p_sid
    and s.revoked_at is null
    and s.idle_expires_at > now()
    and s.expires_at > now();
$$;

CREATE OR REPLACE FUNCTION session_revoke(
    p_sid uuid
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  update iam.session
     set revoked_at = now(), revoke_reason = coalesce(revoke_reason, 'logout')
   where id = p_sid and revoked_at is null;
$$;

CREATE OR REPLACE FUNCTION session_revoke_all(
    p_sid uuid
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  update iam.session
     set revoked_at = now(), revoke_reason = coalesce(revoke_reason, 'logout_all')
   where user_id = (select user_id from iam.session where id = p_sid)
     and revoked_at is null;
$$;

CREATE OR REPLACE FUNCTION session_set_role(
    p_sid uuid,
    p_role text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
  v_kind text;
begin
  select user_id, user_kind into v_user_id, v_kind
    from iam.session
   where id = p_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_user_id is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;
  if v_kind = 'external' then
    if p_role <> 'ext_user' then
      raise exception 'external_session_requires_ext_user' using errcode = '42501';
    end if;
  elsif p_role = 'ext_user' or not exists (
    select 1 from iam.role_assignment a
     where a.user_id = v_user_id
       and a.db_role = p_role
       and a.revoked_at is null
       and a.valid @> now()
  ) then
    raise exception 'role_not_assigned' using errcode = '42501';
  end if;
  update iam.session set active_role = p_role where id = p_sid;
end;
$$;

CREATE OR REPLACE FUNCTION session_touch(
    p_sid uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_kind text;
  v_idle interval;
begin
  select user_kind into v_kind
    from iam.session
   where id = p_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_kind is null then
    return null;
  end if;
  v_idle := case when v_kind = 'external' then interval '30 minutes' else interval '60 minutes' end;
  update iam.session
     set last_seen_at = now(), idle_expires_at = now() + v_idle
   where id = p_sid;
  return auth.session_read(p_sid);
end;
$$;

CREATE OR REPLACE FUNCTION session_write(
    p_sid uuid,
    p_data jsonb
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  update iam.session
     set data = coalesce(p_data, '{}'::jsonb)
   where id = p_sid
     and revoked_at is null
     and idle_expires_at > now()
     and expires_at > now();
$$;

CREATE OR REPLACE FUNCTION token_consume(
    p_purpose text,
    p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
begin
  if p_purpose not in ('invite', 'password_reset') then
    raise exception 'unknown_token_purpose' using errcode = '22023';
  end if;
  update iam.one_time_token
     set used_at = now()
   where purpose = p_purpose
     and token_hash = sha256(convert_to(p_token, 'UTF8'))
     and used_at is null
     and expires_at > now()
  returning user_id into v_user;
  if v_user is null then
    return null;
  end if;
  return jsonb_build_object('user_id', v_user);
end;
$$;

CREATE OR REPLACE FUNCTION set_password(
    p_credential text,
    p_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_session_user uuid;
  v_consumed jsonb;
begin
  if p_hash is null or length(p_hash) < 20 then
    raise exception 'invalid_password_hash' using errcode = '22023';
  end if;
  if p_credential ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select user_id into v_session_user
      from iam.session
     where id = p_credential::uuid
       and revoked_at is null
       and idle_expires_at > now()
       and expires_at > now();
    if v_session_user is null then
      raise exception 'session_not_found' using errcode = '42501';
    end if;
    v_user := v_session_user;
  else
    v_consumed := auth.token_consume('password_reset', p_credential);
    if v_consumed is null then
      v_consumed := auth.token_consume('invite', p_credential);
    end if;
    if v_consumed is null then
      raise exception 'invalid_token' using errcode = '42501';
    end if;
    v_user := (v_consumed ->> 'user_id')::uuid;
  end if;
  if not exists (select 1 from iam.app_user where id = v_user and kind = 'external') then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  insert into iam.password_credential (user_id, hash)
  values (v_user, p_hash)
  on conflict (user_id) do update set hash = excluded.hash, set_at = now();
  update iam.app_user set status = 'active' where id = v_user and status = 'invited';
  update iam.session
     set revoked_at = now(), revoke_reason = 'password_reset'
   where user_id = v_user and revoked_at is null;
  return jsonb_build_object('user_id', v_user);
end;
$$;

CREATE OR REPLACE FUNCTION token_issue(
    p_target_user uuid,
    p_purpose text,
    p_by_sid uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_actor uuid;
  v_actor_role text;
  v_target iam.app_user;
  v_token text;
  v_expires timestamptz;
begin
  if p_purpose not in ('invite', 'password_reset') then
    raise exception 'unknown_token_purpose' using errcode = '22023';
  end if;
  select user_id, active_role into v_actor, v_actor_role
    from iam.session
   where id = p_by_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_actor is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;
  select * into v_target from iam.app_user where id = p_target_user;
  if not found or v_target.status = 'deactivated' then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if v_actor <> p_target_user and v_actor_role not in ('int_coordinator', 'int_sysadmin') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  if p_purpose = 'invite' and v_target.kind <> 'external' then
    raise exception 'invite_requires_external_user' using errcode = '42501';
  end if;
  v_expires := case when p_purpose = 'invite' then now() + interval '72 hours' else now() + interval '30 minutes' end;
  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (p_target_user, p_purpose, sha256(convert_to(v_token, 'UTF8')), v_expires, v_actor);
  return jsonb_build_object('token', v_token, 'expires_at', v_expires);
end;
$$;

CREATE OR REPLACE FUNCTION unlink_identity(
    p_sid uuid,
    p_identity_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_step_up timestamptz;
  v_remaining int;
begin
  select user_id, nullif(data ->> 'stepUpAt', '')::timestamptz
    into v_user, v_step_up
    from iam.session
   where id = p_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_user is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;
  if v_step_up is null or v_step_up < now() - interval '10 minutes' then
    raise exception 'step_up_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from iam.user_identity
     where id = p_identity_id and user_id = v_user and unlinked_at is null
  ) then
    raise exception 'identity_not_found' using errcode = '42501';
  end if;
  select count(*) into v_remaining
    from iam.user_identity i
   where i.user_id = v_user and i.id <> p_identity_id and i.unlinked_at is null;
  if v_remaining = 0 and not exists (
    select 1 from iam.password_credential where user_id = v_user
  ) then
    raise exception 'last_sign_in_method' using errcode = '42501';
  end if;
  update iam.user_identity set unlinked_at = now() where id = p_identity_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION is_throttled(p_login_name text, p_ip inet, p_window interval, p_max_attempts integer) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION link_identity(p_sid uuid, p_provider text, p_issuer text, p_subject text, p_email text, p_tenant_id uuid, p_object_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION log_event(p_event_type text, p_outcome text, p_subject_id uuid, p_detail jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION password_lookup(p_login_name text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION record_attempt(p_login_name text, p_ip inet, p_outcome text, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION resolve_entra(p_tid uuid, p_oid uuid, p_upn text, p_name text, p_app_roles text[]) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION resolve_external(p_provider text, p_issuer text, p_subject text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_create(p_user_id uuid, p_method text, p_active_role text, p_ip inet, p_user_agent text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_read(p_sid uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_revoke(p_sid uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_revoke_all(p_sid uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_set_role(p_sid uuid, p_role text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_touch(p_sid uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_write(p_sid uuid, p_data jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION set_password(p_credential text, p_hash text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION token_consume(p_purpose text, p_token text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION token_issue(p_target_user uuid, p_purpose text, p_by_sid uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION unlink_identity(p_sid uuid, p_identity_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION is_throttled(p_login_name text, p_ip inet, p_window interval, p_max_attempts integer) TO auth_gateway;

GRANT EXECUTE ON FUNCTION link_identity(p_sid uuid, p_provider text, p_issuer text, p_subject text, p_email text, p_tenant_id uuid, p_object_id uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION log_event(p_event_type text, p_outcome text, p_subject_id uuid, p_detail jsonb) TO auth_gateway;

GRANT EXECUTE ON FUNCTION password_lookup(p_login_name text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION record_attempt(p_login_name text, p_ip inet, p_outcome text, p_reason text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION resolve_entra(p_tid uuid, p_oid uuid, p_upn text, p_name text, p_app_roles text[]) TO auth_gateway;

GRANT EXECUTE ON FUNCTION resolve_external(p_provider text, p_issuer text, p_subject text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_create(p_user_id uuid, p_method text, p_active_role text, p_ip inet, p_user_agent text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_read(p_sid uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_revoke(p_sid uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_revoke_all(p_sid uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_set_role(p_sid uuid, p_role text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_touch(p_sid uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_write(p_sid uuid, p_data jsonb) TO auth_gateway;

GRANT EXECUTE ON FUNCTION set_password(p_credential text, p_hash text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION token_consume(p_purpose text, p_token text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION token_issue(p_target_user uuid, p_purpose text, p_by_sid uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION unlink_identity(p_sid uuid, p_identity_id uuid) TO auth_gateway;
