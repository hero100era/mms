-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION request_password_reset(
    p_email text,
    p_client_ip inet DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
  v_display_name text;
  v_status text;
  v_token text;
  v_expires timestamptz;
begin
  if p_email is null or btrim(p_email) = '' or p_email not like '%@%' or p_email like '% %' then
    return;
  end if;

  select id, display_name, status
    into v_user_id, v_display_name, v_status
    from iam.app_user
   where email = lower(btrim(p_email))
     and kind = 'external';

  if v_user_id is null or v_status not in ('invited', 'active') then
    return;
  end if;

  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  v_expires := now() + interval '30 minutes';

  update iam.one_time_token
     set expires_at = now()
   where user_id = v_user_id
     and purpose = 'password_reset'
     and used_at is null
     and expires_at > now();

  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at)
  values (v_user_id, 'password_reset', sha256(convert_to(v_token, 'UTF8')), v_expires);

  insert into core.outbox (kind, payload, status)
  values (
    'password_reset_email',
    jsonb_build_object(
      'user_id', v_user_id,
      'email', lower(btrim(p_email)),
      'display_name', v_display_name,
      'token', v_token
    ),
    'pending'
  );

  perform auth.log_event(
    'auth.password.reset_requested',
    'success',
    v_user_id,
    jsonb_build_object('client_ip', p_client_ip::text)
  );
end;
$$;

CREATE OR REPLACE FUNCTION session_revoke(
    p_actor_sid uuid,
    p_target_sid uuid
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
  select user_id into v_user_id
    from iam.session
   where id = p_actor_sid
     and revoked_at is null
     and idle_expires_at > now()
     and expires_at > now();
  if v_user_id is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = 'user_revoked'
   where id = p_target_sid
     and user_id = v_user_id
     and revoked_at is null;

  if not found then
    raise exception 'target_session_not_found' using errcode = '42501';
  end if;

  perform auth.log_event('auth.session.revoked', 'success', v_user_id, jsonb_build_object('session_id', p_target_sid));
end;
$$;

CREATE OR REPLACE FUNCTION session_revoke_all(
    p_sid uuid,
    p_keep_current boolean
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
  select user_id into v_user_id
    from iam.session
   where id = p_sid
     and revoked_at is null
     and idle_expires_at > now()
     and expires_at > now();
  if v_user_id is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = case when p_keep_current then 'revoke_others' else 'logout_all' end
   where user_id = v_user_id
     and revoked_at is null
     and (not p_keep_current or id <> p_sid);

  perform auth.log_event('auth.session.revoked', 'success', v_user_id, jsonb_build_object('revoked_all', true, 'kept_current', p_keep_current));
end;
$$;

CREATE OR REPLACE FUNCTION user_sessions(
    p_sid uuid
)
RETURNS TABLE(id uuid, active_role text, auth_method text, created_at timestamptz, last_seen_at timestamptz, idle_expires_at timestamptz, expires_at timestamptz, client_ip inet, user_agent text, is_current boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
begin
  select s.user_id into v_user_id
    from iam.session s
   where s.id = p_sid
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.expires_at > now();
  if v_user_id is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;
  return query
    select s.id, s.active_role, s.auth_method, s.created_at, s.last_seen_at,
           s.idle_expires_at, s.expires_at, s.client_ip, s.user_agent,
           (s.id = p_sid) as is_current
      from iam.session s
     where s.user_id = v_user_id
       and s.revoked_at is null
       and s.idle_expires_at > now()
       and s.expires_at > now()
     order by s.last_seen_at desc;
end;
$$;

REVOKE EXECUTE ON FUNCTION request_password_reset(p_email text, p_client_ip inet) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_revoke(p_actor_sid uuid, p_target_sid uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION session_revoke_all(p_sid uuid, p_keep_current boolean) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION user_sessions(p_sid uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION session_revoke(
    p_sid uuid
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
     set revoked_at = now(), revoke_reason = coalesce(revoke_reason, 'logout')
   where id = p_sid and revoked_at is null;
  if v_user_id is not null then
    perform auth.log_event('auth.logout', 'success', v_user_id, jsonb_build_object('session_id', p_sid));
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION session_revoke_all(
    p_sid uuid
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
  select user_id into v_user_id
    from iam.session
   where id = p_sid
     and revoked_at is null
     and idle_expires_at > now()
     and expires_at > now();
  if v_user_id is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = 'logout_all'
   where user_id = v_user_id
     and revoked_at is null;

  perform auth.log_event('auth.session.revoked', 'success', v_user_id, jsonb_build_object('revoked_all', true, 'kept_current', false));
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
  v_status text;
  v_is_reset boolean := false;
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
    if v_consumed is not null then
      v_is_reset := true;
    else
      v_consumed := auth.token_consume('invite', p_credential);
    end if;
    if v_consumed is null then
      raise exception 'invalid_token' using errcode = '42501';
    end if;
    v_user := (v_consumed ->> 'user_id')::uuid;
  end if;
  select status into v_status from iam.app_user where id = v_user and kind = 'external';
  if not found then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  if v_status not in ('invited', 'active') then
    raise exception 'user_inactive' using errcode = '42501';
  end if;
  insert into iam.password_credential (user_id, hash)
  values (v_user, p_hash)
  on conflict (user_id) do update set hash = excluded.hash, set_at = now();
  if v_status = 'invited' then
    update iam.app_user
       set status = 'active',
           email_verified_at = coalesce(email_verified_at, now())
     where id = v_user;
    perform auth.log_event('auth.invite.accepted', 'success', v_user, '{}'::jsonb);
  end if;
  perform auth.log_event('auth.password.set', 'success', v_user, jsonb_build_object('method', 'password'));
  if v_is_reset then
    perform auth.log_event('auth.password.reset_completed', 'success', v_user, '{}'::jsonb);
  end if;
  update iam.session
     set revoked_at = now(), revoke_reason = 'password_reset'
   where user_id = v_user and revoked_at is null;
  return jsonb_build_object('user_id', v_user);
end;
$$;

GRANT EXECUTE ON FUNCTION request_password_reset(p_email text, p_client_ip inet) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_revoke(p_actor_sid uuid, p_target_sid uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION session_revoke_all(p_sid uuid, p_keep_current boolean) TO auth_gateway;

GRANT EXECUTE ON FUNCTION user_sessions(p_sid uuid) TO auth_gateway;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION my_profile()
RETURNS TABLE(id uuid, email text, display_name text, kind text, status text, created_at timestamptz, email_verified_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select u.id, u.email, u.display_name, u.kind, u.status, u.created_at, u.email_verified_at
    from iam.app_user u
   where u.id = private.uid();
$$;

CREATE OR REPLACE FUNCTION my_sessions()
RETURNS TABLE(id uuid, active_role text, auth_method text, created_at timestamptz, last_seen_at timestamptz, idle_expires_at timestamptz, expires_at timestamptz, client_ip inet, user_agent text, is_current boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select s.id, s.active_role, s.auth_method, s.created_at, s.last_seen_at,
         s.idle_expires_at, s.expires_at, s.client_ip, s.user_agent,
         (s.id = nullif(private.claim('sid'), '')::uuid) as is_current
    from iam.session s
   where s.user_id = private.uid()
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.expires_at > now()
   order by s.last_seen_at desc;
$$;

CREATE OR REPLACE FUNCTION revoke_all_my_sessions(
    p_keep_current boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid := private.uid();
  v_current_sid uuid := nullif(private.claim('sid'), '')::uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = case when p_keep_current then 'revoke_others' else 'logout_all' end
   where user_id = v_user_id
     and revoked_at is null
     and (not p_keep_current or id <> v_current_sid);

  perform private.emit_event(
    'auth.session.revoked', 'success', 'app_user', v_user_id, null, 'logout_all',
    jsonb_build_object('revoked_all', true, 'kept_current', p_keep_current)
  );
end;
$$;

CREATE OR REPLACE FUNCTION revoke_my_session(
    p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid := private.uid();
begin
  if v_user_id is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = 'user_revoked'
   where id = p_session_id
     and user_id = v_user_id
     and revoked_at is null;

  if not found then
    raise exception 'session_not_found_or_revoked' using errcode = '42501';
  end if;

  perform private.emit_event(
    'auth.session.revoked', 'success', 'app_user', v_user_id, null, 'user_revoked',
    jsonb_build_object('session_id', p_session_id)
  );
end;
$$;

REVOKE EXECUTE ON FUNCTION my_profile() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_sessions() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION my_profile() TO ext_user;

GRANT EXECUTE ON FUNCTION my_profile() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_profile() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_profile() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_profile() TO int_finance;

GRANT EXECUTE ON FUNCTION my_profile() TO int_hr;

GRANT EXECUTE ON FUNCTION my_profile() TO int_manager;

GRANT EXECUTE ON FUNCTION my_profile() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_profile() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_profile() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_sessions() TO ext_user;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_finance;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_hr;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_manager;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_sessions() TO int_viewer;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO ext_user;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_auditor;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_compliance;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_coordinator;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_finance;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_hr;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_manager;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_surveyor;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION revoke_all_my_sessions(p_keep_current boolean) TO int_viewer;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO ext_user;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION revoke_my_session(p_session_id uuid) TO int_viewer;
