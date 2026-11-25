-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION job_begin(
    p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_job core.outbox;
  v_worker_id uuid;
  v_worker_name text;
begin
  if session_user <> 'worker' then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  select id, display_name into v_worker_id, v_worker_name
    from iam.app_user
   where kind = 'service' and service_name = 'worker' and status = 'active';

  if v_worker_id is null then
    insert into iam.app_user (id, kind, display_name, service_name, status)
    values ('00000000-0000-0000-0000-000000000001', 'service', 'Outbox Worker', 'worker', 'active')
    on conflict (service_name) do update set status = 'active'
    returning id, display_name into v_worker_id, v_worker_name;
  end if;

  select * into v_job
    from core.outbox
   where id = p_job_id
     for update;

  if not found then
    raise exception 'job_not_found';
  end if;

  if v_job.status <> 'pending' then
    raise exception 'job_not_pending' using errcode = '55P03';
  end if;

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub', v_worker_id::text,
      'name', coalesce(v_worker_name, 'worker'),
      'role', 'worker',
      'src', 'job'
    )::text, true);

  if v_job.enqueued_by is not null then
    perform set_config('mms.initiated_by', v_job.enqueued_by::text, true);
  else
    perform set_config('mms.initiated_by', '', true);
  end if;

  update core.outbox
     set status = 'processing',
         attempts = attempts + 1
   where id = p_job_id
  returning * into v_job;

  return jsonb_build_object(
    'id', v_job.id,
    'kind', v_job.kind,
    'payload', v_job.payload,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'enqueued_by', v_job.enqueued_by,
    'created_at', v_job.created_at
  );
end;
$$;

CREATE OR REPLACE FUNCTION job_complete(
    p_job_id uuid,
    p_status text DEFAULT 'done',
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_job core.outbox;
  v_worker_id uuid;
  v_worker_name text;
begin
  if session_user <> 'worker' then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  if p_status not in ('done', 'failed') then
    raise exception 'invalid_job_status' using errcode = '22023';
  end if;

  select * into v_job
    from core.outbox
   where id = p_job_id and status = 'processing'
     for update;

  if not found then
    raise exception 'job_not_processing';
  end if;

  select id, display_name into v_worker_id, v_worker_name
    from iam.app_user
   where kind = 'service' and service_name = 'worker' and status = 'active';

  if v_worker_id is not null then
    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', v_worker_id::text,
        'name', coalesce(v_worker_name, 'worker'),
        'role', 'worker',
        'src', 'job'
      )::text, true);
  end if;

  if v_job.enqueued_by is not null then
    perform set_config('mms.initiated_by', v_job.enqueued_by::text, true);
  end if;

  update core.outbox
     set status = p_status,
         payload = case
           when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
           else payload
         end
   where id = p_job_id;
end;
$$;

CREATE OR REPLACE FUNCTION job_poll(
    p_limit integer DEFAULT 10
)
RETURNS TABLE(id uuid, kind text, payload jsonb, attempts integer, enqueued_by uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  select o.id, o.kind, o.payload, o.attempts, o.enqueued_by
    from core.outbox o
   where o.status = 'pending'
     and o.next_at <= now()
   order by o.next_at, o.created_at
   limit coalesce(p_limit, 10);
$$;

REVOKE EXECUTE ON FUNCTION job_begin(p_job_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION job_complete(p_job_id uuid, p_status text, p_error text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION job_poll(p_limit integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION job_begin(p_job_id uuid) TO worker;

GRANT EXECUTE ON FUNCTION job_complete(p_job_id uuid, p_status text, p_error text) TO worker;

GRANT EXECUTE ON FUNCTION job_poll(p_limit integer) TO worker;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE OR REPLACE TRIGGER outbox_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON outbox
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION record_attempt(
    p_login_name text,
    p_ip inet,
    p_outcome text,
    p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
  v_count int;
begin
  insert into iam.login_attempt (login_name, client_ip, outcome, reason)
  values (lower(p_login_name), p_ip, p_outcome, p_reason);

  if p_outcome = 'failure' then
    select count(*) into v_count
      from iam.login_attempt a
     where a.at > now() - interval '15 minutes'
       and a.outcome = 'failure'
       and (a.login_name = lower(p_login_name) or a.client_ip = p_ip);

    if v_count = 5 then
      select id into v_user_id
        from iam.app_user
       where email = lower(p_login_name)
         and kind = 'external'
         and status <> 'deactivated';

      perform auth.log_event(
        'auth.lockout',
        'failure',
        v_user_id,
        jsonb_build_object(
          'login_name', lower(p_login_name),
          'client_ip', p_ip::text,
          'reason', coalesce(p_reason, 'too_many_failures')
        )
      );
    end if;
  end if;
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
  update iam.session
     set revoked_at = now(), revoke_reason = 'password_reset'
   where user_id = v_user and revoked_at is null;
  return jsonb_build_object('user_id', v_user);
end;
$$;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION create_external_user(
    p_email text,
    p_display_name text,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user_id uuid;
  v_token text;
  v_expires timestamptz;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  if p_email is null or btrim(p_email) = '' or p_email not like '%@%' or p_email like '% %' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name_required' using errcode = '22023';
  end if;

  p_email := lower(btrim(p_email));
  p_display_name := btrim(p_display_name);

  if exists (
    select 1 from iam.app_user
     where email = p_email and kind = 'external' and status <> 'deactivated'
  ) then
    raise exception 'email_already_registered' using errcode = '23505';
  end if;

  insert into iam.app_user (kind, email, display_name, status, created_by)
  values ('external', p_email, p_display_name, 'invited', private.uid())
  returning id into v_user_id;

  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  v_expires := now() + interval '72 hours';

  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (v_user_id, 'invite', sha256(convert_to(v_token, 'UTF8')), v_expires, private.uid());

  insert into core.outbox (kind, payload, status, enqueued_by)
  values (
    'invite_email',
    jsonb_build_object(
      'user_id', v_user_id,
      'email', lower(p_email),
      'display_name', p_display_name,
      'token', v_token
    ),
    'pending',
    private.uid()
  );

  perform private.emit_event(
    'auth.user.created', 'success', 'app_user', v_user_id, null, p_reason,
    jsonb_build_object('email', lower(p_email), 'kind', 'external')
  );

  perform private.emit_event(
    'auth.invite.created', 'success', 'app_user', v_user_id, null, p_reason,
    jsonb_build_object('expires_at', v_expires)
  );

  return v_user_id;
end;
$$;

CREATE OR REPLACE FUNCTION external_users()
RETURNS TABLE(id uuid, email text, display_name text, status text, created_at timestamptz, email_verified_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select u.id, u.email, u.display_name, u.status, u.created_at, u.email_verified_at
    from iam.app_user u
   where u.kind = 'external'
   order by u.created_at desc;
$$;

CREATE OR REPLACE FUNCTION invite_external_user(
    p_user_id uuid,
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
  v_token text;
  v_expires timestamptz;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  select * into v_user from iam.app_user where id = p_user_id and kind = 'external';
  if not found then
    raise exception 'external_user_not_found';
  end if;
  if v_user.status = 'deactivated' then
    raise exception 'user_deactivated';
  end if;
  if v_user.status <> 'invited' then
    raise exception 'user_already_active_or_not_invited' using errcode = '42501';
  end if;

  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  v_expires := now() + interval '72 hours';

  update iam.one_time_token
     set expires_at = now()
   where user_id = p_user_id
     and purpose = 'invite'
     and used_at is null
     and expires_at > now();

  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (p_user_id, 'invite', sha256(convert_to(v_token, 'UTF8')), v_expires, private.uid());

  insert into core.outbox (kind, payload, status, enqueued_by)
  values (
    'invite_email',
    jsonb_build_object(
      'user_id', p_user_id,
      'email', v_user.email,
      'display_name', v_user.display_name,
      'token', v_token
    ),
    'pending',
    private.uid()
  );

  perform private.emit_event(
    'auth.invite.created', 'success', 'app_user', p_user_id, null, p_reason,
    jsonb_build_object('expires_at', v_expires)
  );
end;
$$;

REVOKE EXECUTE ON FUNCTION create_external_user(p_email text, p_display_name text, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION external_users() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION invite_external_user(p_user_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION create_external_user(p_email text, p_display_name text, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION create_external_user(p_email text, p_display_name text, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION create_external_user(p_email text, p_display_name text, p_reason text) TO int_viewer;

GRANT EXECUTE ON FUNCTION external_users() TO int_coordinator;

GRANT EXECUTE ON FUNCTION external_users() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION invite_external_user(p_user_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION invite_external_user(p_user_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION invite_external_user(p_user_id uuid, p_reason text) TO int_viewer;
