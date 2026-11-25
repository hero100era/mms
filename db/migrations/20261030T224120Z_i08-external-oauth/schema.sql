-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION link_identity_by_token(
    p_token text,
    p_provider text,
    p_issuer text,
    p_subject text,
    p_email text,
    p_tenant_id uuid,
    p_object_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION user_identities(
    p_sid uuid
)
RETURNS TABLE(id uuid, provider text, issuer text, email_at_link text, linked_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

REVOKE EXECUTE ON FUNCTION link_identity_by_token(p_token text, p_provider text, p_issuer text, p_subject text, p_email text, p_tenant_id uuid, p_object_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION user_identities(p_sid uuid) FROM PUBLIC;

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

GRANT EXECUTE ON FUNCTION link_identity_by_token(p_token text, p_provider text, p_issuer text, p_subject text, p_email text, p_tenant_id uuid, p_object_id uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION user_identities(p_sid uuid) TO auth_gateway;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION my_identities()
RETURNS TABLE(id uuid, provider text, issuer text, email_at_link text, linked_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select i.id, i.provider, i.issuer, i.email_at_link, i.linked_at
    from iam.user_identity i
   where i.user_id = private.uid()
     and i.unlinked_at is null
   order by i.linked_at desc;
$$;

REVOKE EXECUTE ON FUNCTION my_identities() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION my_identities() TO ext_user;

GRANT EXECUTE ON FUNCTION my_identities() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_identities() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_identities() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_identities() TO int_finance;

GRANT EXECUTE ON FUNCTION my_identities() TO int_hr;

GRANT EXECUTE ON FUNCTION my_identities() TO int_manager;

GRANT EXECUTE ON FUNCTION my_identities() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_identities() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_identities() TO int_viewer;
