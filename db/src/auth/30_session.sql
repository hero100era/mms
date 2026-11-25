create function auth.session_create(
  p_user_id uuid,
  p_method text,
  p_active_role text,
  p_ip inet,
  p_user_agent text,
  p_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.session_read(p_sid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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

create function auth.session_touch(p_sid uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_user_id uuid;
  v_is_break_glass boolean := false;
  v_idle interval;
begin
  select user_kind, user_id into v_kind, v_user_id
    from iam.session
   where id = p_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_kind is null then
    return null;
  end if;
  select exists (
    select 1 from iam.break_glass_account where user_id = v_user_id and enabled
  ) into v_is_break_glass;
  v_idle := case
    when v_kind = 'external' or v_is_break_glass then interval '30 minutes'
    else interval '60 minutes'
  end;
  update iam.session
     set last_seen_at = now(), idle_expires_at = now() + v_idle
   where id = p_sid;
  return auth.session_read(p_sid);
end;
$$;

create function auth.session_write(p_sid uuid, p_data jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update iam.session
     set data = coalesce(p_data, '{}'::jsonb)
   where id = p_sid
     and revoked_at is null
     and idle_expires_at > now()
     and expires_at > now();
$$;

create function auth.session_set_role(p_sid uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.session_revoke(p_sid uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select auth.session_revoke_reason(p_sid, 'logout');
$$;

create function auth.session_revoke_reason(p_sid uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.session_revoke(p_actor_sid uuid, p_target_sid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.session_revoke_all(p_sid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.session_revoke_all(p_sid uuid, p_keep_current boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.user_sessions(p_sid uuid)
returns table(
  id uuid,
  active_role text,
  auth_method text,
  created_at timestamptz,
  last_seen_at timestamptz,
  idle_expires_at timestamptz,
  expires_at timestamptz,
  client_ip inet,
  user_agent text,
  is_current boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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

-- R2-H01: Multi-replica pre-authentication session persistence (CSRF & OAuth
-- PKCE/state/nonce transactions before login creates an iam.session row).
create function auth.pre_auth_read(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select data
    from iam.pre_auth_session
   where id = p_id
     and expires_at > now();
$$;

create function auth.pre_auth_write(
  p_id text,
  p_data jsonb,
  p_ttl interval default interval '10 minutes'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into iam.pre_auth_session (id, data, expires_at)
  values (p_id, coalesce(p_data, '{}'::jsonb), now() + p_ttl)
  on conflict (id) do update
    set data = excluded.data,
        expires_at = excluded.expires_at;

  -- Opportunistic cleanup of expired pre-auth sessions
  delete from iam.pre_auth_session where expires_at <= now();
end;
$$;

create function auth.pre_auth_delete(p_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from iam.pre_auth_session where id = p_id;
$$;

revoke all on function auth.pre_auth_read(text) from public;
revoke all on function auth.pre_auth_write(text, jsonb, interval) from public;
revoke all on function auth.pre_auth_delete(text) from public;

grant execute on function auth.pre_auth_read(text) to auth_gateway;
grant execute on function auth.pre_auth_write(text, jsonb, interval) to auth_gateway;
grant execute on function auth.pre_auth_delete(text) to auth_gateway;
