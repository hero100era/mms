create function auth.token_issue(
  p_target_user uuid,
  p_purpose text,
  p_by_sid uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.token_consume(p_purpose text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.request_password_reset(
  p_email text,
  p_client_ip inet default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.set_password(p_credential text, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_session_user uuid;
  v_consumed jsonb;
  v_status text;
  v_email text;
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
  select status, email into v_status, v_email from iam.app_user where id = v_user and kind = 'external';
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
  return jsonb_build_object('user_id', v_user, 'email', v_email);
end;
$$;

create function auth.link_identity(
  p_sid uuid,
  p_provider text,
  p_issuer text,
  p_subject text,
  p_email text,
  p_tenant_id uuid,
  p_object_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_step_up timestamptz;
begin
  select user_id,
         coalesce(
           nullif(case when jsonb_typeof(data) = 'array' then data->0->>'stepUpAt' else data->>'stepUpAt' end, ''),
           nullif(case when jsonb_typeof(data) = 'array' then data->0->'auth'->>'stepUpAt' else data->'auth'->>'stepUpAt' end, '')
         )::timestamptz
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
  perform 1 from iam.app_user where id = v_user and kind = 'external' and status = 'active' for update;
  if not found then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  if p_provider not in ('microsoft', 'google') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;
  if exists (
    select 1 from iam.user_identity
     where issuer = p_issuer and subject = p_subject and unlinked_at is null
  ) then
    raise exception 'duplicate_identity_link' using errcode = '23505';
  end if;
  insert into iam.user_identity (
    user_id, provider, issuer, subject, tenant_id, object_id, email_at_link
  ) values (
    v_user, p_provider, p_issuer, p_subject, p_tenant_id, p_object_id,
    case when p_email like '%@%' then lower(p_email) end
  );
  perform auth.log_event('auth.identity.linked', 'success', v_user, jsonb_build_object('provider', p_provider, 'issuer', p_issuer));
end;
$$;

create function auth.link_identity_by_token(
  p_token text,
  p_provider text,
  p_issuer text,
  p_subject text,
  p_email text,
  p_tenant_id uuid,
  p_object_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consumed jsonb;
  v_user uuid;
  v_status text;
begin
  if p_provider not in ('microsoft', 'google') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;
  v_consumed := auth.token_consume('invite', p_token);
  if v_consumed is null then
    raise exception 'invalid_token' using errcode = '42501';
  end if;
  v_user := (v_consumed ->> 'user_id')::uuid;
  select status into v_status
    from iam.app_user
   where id = v_user and kind = 'external'
     for update;
  if not found then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  if v_status not in ('invited', 'active') then
    raise exception 'user_inactive' using errcode = '42501';
  end if;
  if exists (
    select 1 from iam.user_identity
     where issuer = p_issuer and subject = p_subject and unlinked_at is null
  ) then
    raise exception 'duplicate_identity_link' using errcode = '23505';
  end if;
  insert into iam.user_identity (
    user_id, provider, issuer, subject, tenant_id, object_id, email_at_link
  ) values (
    v_user, p_provider, p_issuer, p_subject, p_tenant_id, p_object_id,
    case when p_email like '%@%' then lower(p_email) end
  );
  if v_status = 'invited' then
    update iam.app_user
       set status = 'active',
           email_verified_at = coalesce(email_verified_at, now())
     where id = v_user;
    perform auth.log_event('auth.invite.accepted', 'success', v_user, '{}'::jsonb);
  end if;
  perform auth.log_event('auth.identity.linked', 'success', v_user, jsonb_build_object('provider', p_provider, 'issuer', p_issuer));
  return jsonb_build_object('user_id', v_user);
end;
$$;

create function auth.unlink_identity(p_sid uuid, p_identity_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_step_up timestamptz;
  v_remaining int;
  v_provider text;
  v_issuer text;
begin
  select user_id,
         coalesce(
           nullif(case when jsonb_typeof(data) = 'array' then data->0->>'stepUpAt' else data->>'stepUpAt' end, ''),
           nullif(case when jsonb_typeof(data) = 'array' then data->0->'auth'->>'stepUpAt' else data->'auth'->>'stepUpAt' end, '')
         )::timestamptz
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
  perform 1 from iam.app_user where id = v_user and kind = 'external' and status = 'active' for update;
  if not found then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  select provider, issuer into v_provider, v_issuer
    from iam.user_identity
   where id = p_identity_id and user_id = v_user and unlinked_at is null;
  if not found then
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
  perform auth.log_event('auth.identity.unlinked', 'success', v_user, jsonb_build_object('provider', v_provider, 'issuer', v_issuer));
end;
$$;

create function auth.user_identities(p_sid uuid)
returns table(id uuid, provider text, issuer text, email_at_link text, linked_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select s.user_id into v_user
    from iam.session s
   where s.id = p_sid and s.revoked_at is null
     and s.idle_expires_at > now() and s.expires_at > now();
  if v_user is null then
    raise exception 'session_not_found' using errcode = '42501';
  end if;
  return query
    select i.id, i.provider, i.issuer, i.email_at_link, i.linked_at
      from iam.user_identity i
     where i.user_id = v_user
       and i.unlinked_at is null
     order by i.linked_at desc;
end;
$$;

create function auth.log_event(
  p_event_type text,
  p_outcome text,
  p_subject_id uuid,
  p_detail jsonb default '{}'
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.emit_event(p_event_type, p_outcome, 'user', p_subject_id, null, null, p_detail);
$$;

revoke all on schema auth from public;
revoke all on all functions in schema auth from public;
grant usage on schema auth to auth_gateway, worker;
grant execute on all functions in schema auth to auth_gateway;

