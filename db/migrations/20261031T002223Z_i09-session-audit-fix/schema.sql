-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION session_revoke(
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

REVOKE EXECUTE ON FUNCTION session_revoke(p_sid uuid, p_reason text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION session_revoke(
    p_sid uuid
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  select auth.session_revoke(p_sid, 'logout');
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
     set revoked_at = now(), revoke_reason = case when v_is_reset then 'password_reset' else 'password_changed' end
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
  update iam.one_time_token
     set expires_at = now()
   where user_id = p_target_user
     and purpose = p_purpose
     and used_at is null
     and expires_at > now();
  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (p_target_user, p_purpose, sha256(convert_to(v_token, 'UTF8')), v_expires, v_actor);
  return jsonb_build_object('token', v_token, 'expires_at', v_expires);
end;
$$;

GRANT EXECUTE ON FUNCTION session_revoke(p_sid uuid, p_reason text) TO auth_gateway;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

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
    'auth.session.revoked', 'success', 'app_user', v_user_id, null,
    case when p_keep_current then 'revoke_others' else 'logout_all' end,
    jsonb_build_object('revoked_all', true, 'kept_current', p_keep_current)
  );
end;
$$;
