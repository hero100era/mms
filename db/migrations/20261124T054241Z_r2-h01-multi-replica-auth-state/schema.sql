-- ===== schema: iam  (pgschema 1.14.1) =====

set local search_path = iam;

CREATE TABLE IF NOT EXISTS pre_auth_session (
    id text,
    data jsonb DEFAULT '{}' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    CONSTRAINT pre_auth_session_pkey PRIMARY KEY (id),
    CONSTRAINT pre_auth_session_id_ck CHECK (btrim(id) <> ''::text)
);

CREATE INDEX IF NOT EXISTS pre_auth_session_expires_ix ON pre_auth_session (expires_at);

ALTER TABLE pre_auth_session ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS step_up_attempt (
    id bigint GENERATED ALWAYS AS IDENTITY,
    at timestamptz DEFAULT now() NOT NULL,
    user_id text NOT NULL,
    client_ip text NOT NULL,
    session_id text,
    outcome text NOT NULL,
    CONSTRAINT step_up_attempt_pk PRIMARY KEY (id),
    CONSTRAINT step_up_attempt_outcome_ck CHECK (outcome IN ('success'::text, 'failure'::text))
);

CREATE INDEX IF NOT EXISTS step_up_attempt_user_at_ix ON step_up_attempt (user_id, at);

ALTER TABLE step_up_attempt ENABLE ROW LEVEL SECURITY;

REVOKE SELECT ON TABLE job_title FROM int_sysadmin;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_sysadmin;

-- ===== schema: auth  (pgschema 1.14.1) =====

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

CREATE OR REPLACE FUNCTION pre_auth_delete(
    p_id text
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  delete from iam.pre_auth_session where id = p_id;
$$;

CREATE OR REPLACE FUNCTION pre_auth_read(
    p_id text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select data
    from iam.pre_auth_session
   where id = p_id
     and expires_at > now();
$$;

CREATE OR REPLACE FUNCTION pre_auth_write(
    p_id text,
    p_data jsonb,
    p_ttl interval DEFAULT '00:10:00'::interval
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION step_up_clear(
    p_user_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_user_id is null then
    delete from iam.step_up_attempt;
  else
    delete from iam.step_up_attempt where user_id = p_user_id;
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION step_up_record(
    p_user_id text,
    p_ip text,
    p_success boolean,
    p_session_id text DEFAULT NULL,
    p_window interval DEFAULT '00:15:00'::interval
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_success then
    delete from iam.step_up_attempt
     where user_id = p_user_id
       and outcome = 'failure';
    return;
  end if;

  insert into iam.step_up_attempt (user_id, client_ip, session_id, outcome)
  values (p_user_id, p_ip, p_session_id, 'failure');

  -- Opportunistic cleanup of expired step-up throttle records
  delete from iam.step_up_attempt
   where at < now() - (p_window * 2);
end;
$$;

CREATE OR REPLACE FUNCTION step_up_status(
    p_user_id text,
    p_ip text,
    p_session_id text DEFAULT NULL,
    p_window interval DEFAULT '00:15:00'::interval,
    p_max_attempts integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_cutoff timestamptz := now() - p_window;
  v_user_count int;
  v_user_oldest timestamptz;
  v_ip_count int;
  v_ip_oldest timestamptz;
  v_sess_count int := 0;
  v_sess_oldest timestamptz := null;
  v_throttled boolean := false;
  v_oldest_throttled timestamptz := null;
  v_retry_after int := 60;
begin
  select count(*), min(a.at)
    into v_user_count, v_user_oldest
    from iam.step_up_attempt a
   where a.user_id = p_user_id
     and a.outcome = 'failure'
     and a.at > v_cutoff;

  select count(*), min(a.at)
    into v_ip_count, v_ip_oldest
    from iam.step_up_attempt a
   where a.user_id = p_user_id
     and a.client_ip = p_ip
     and a.outcome = 'failure'
     and a.at > v_cutoff;

  if p_session_id is not null then
    select count(*), min(a.at)
      into v_sess_count, v_sess_oldest
      from iam.step_up_attempt a
     where a.user_id = p_user_id
       and a.session_id = p_session_id
       and a.outcome = 'failure'
       and a.at > v_cutoff;
  end if;

  if v_user_count >= p_max_attempts then
    v_throttled := true;
    v_oldest_throttled := coalesce(least(v_oldest_throttled, v_user_oldest), v_user_oldest);
  end if;
  if v_ip_count >= p_max_attempts then
    v_throttled := true;
    v_oldest_throttled := coalesce(least(v_oldest_throttled, v_ip_oldest), v_ip_oldest);
  end if;
  if p_session_id is not null and v_sess_count >= p_max_attempts then
    v_throttled := true;
    v_oldest_throttled := coalesce(least(v_oldest_throttled, v_sess_oldest), v_sess_oldest);
  end if;

  if v_throttled and v_oldest_throttled is not null then
    v_retry_after := greatest(1, ceil(extract(epoch from (v_oldest_throttled + p_window - now())))::int);
  end if;

  return jsonb_build_object(
    'throttled', v_throttled,
    'retry_after', v_retry_after
  );
end;
$$;

REVOKE EXECUTE ON FUNCTION pre_auth_delete(p_id text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION pre_auth_read(p_id text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION pre_auth_write(p_id text, p_data jsonb, p_ttl interval) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION step_up_clear(p_user_id text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION step_up_record(p_user_id text, p_ip text, p_success boolean, p_session_id text, p_window interval) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION step_up_status(p_user_id text, p_ip text, p_session_id text, p_window interval, p_max_attempts integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pre_auth_delete(p_id text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION pre_auth_read(p_id text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION pre_auth_write(p_id text, p_data jsonb, p_ttl interval) TO auth_gateway;

GRANT EXECUTE ON FUNCTION step_up_clear(p_user_id text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION step_up_record(p_user_id text, p_ip text, p_success boolean, p_session_id text, p_window interval) TO auth_gateway;

GRANT EXECUTE ON FUNCTION step_up_status(p_user_id text, p_ip text, p_session_id text, p_window interval, p_max_attempts integer) TO auth_gateway;

-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION shred_subject_key(
    p_subject_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_status text;
  v_actor_id uuid := private.uid();
begin
  if private.caller_role() not in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator', 'postgres') then
    raise exception 'shred_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'shred_reason_required' using errcode = '22023';
  end if;

  select key_status into v_status
  from audit_trail.crypto_shred_key
  where subject_id = p_subject_id
  for update;

  if not found then
    insert into audit_trail.crypto_shred_key (
      subject_id, key_status, algorithm, encrypted_key, key_fingerprint,
      created_at, shredded_at, shredded_by, shred_reason
    ) values (
      p_subject_id, 'shredded', 'AES-256-GCM',
      'SHREDDED_ZEROIZED_' || repeat('0', 64),
      'SHREDDED',
      clock_timestamp(),
      clock_timestamp(),
      v_actor_id,
      p_reason
    );

    perform private.emit_event(
      'privacy.crypto_shred.executed',
      'success',
      'data_subject',
      p_subject_id,
      null,
      p_reason,
      jsonb_build_object('subject_id', p_subject_id, 'reason', p_reason)
    );

    return true;
  end if;

  if v_status = 'shredded' then
    return false;
  end if;

  update audit_trail.crypto_shred_key
  set key_status = 'shredded',
      encrypted_key = 'SHREDDED_ZEROIZED_' || repeat('0', 64),
      shredded_at = clock_timestamp(),
      shredded_by = v_actor_id,
      shred_reason = p_reason
  where subject_id = p_subject_id;

  perform private.emit_event(
    'privacy.crypto_shred.executed',
    'success',
    'data_subject',
    p_subject_id,
    null,
    p_reason,
    jsonb_build_object('subject_id', p_subject_id, 'reason', p_reason)
  );

  return true;
end;
$$;

CREATE OR REPLACE FUNCTION purge_sealed_audit_records(
    p_retention_class text,
    p_older_than timestamp with time zone,
    p_max_rows integer DEFAULT 1000,
    p_reason text DEFAULT 'Lifecycle retention purge of sealed audit records'::text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_max_sealed_xid xid8;
  v_purged_change_logs int := 0;
  v_purged_events int := 0;
  v_class_exists boolean;
  v_purge_run_id bigint;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Lifecycle retention purge of sealed audit records');
begin
  if private.caller_role() not in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator', 'postgres') then
    raise exception 'retention_purge_role_required' using errcode = '42501';
  end if;
  select exists (select 1 from audit_trail.retention_class where class_code = p_retention_class)
  into v_class_exists;
  if not v_class_exists then
    raise exception 'invalid_retention_class: %', p_retention_class using errcode = '22023';
  end if;

  select max(to_xid) into v_max_sealed_xid from audit_trail.seal;
  if v_max_sealed_xid is null then
    raise exception 'cannot_purge_unsealed_audit: no audit seals exist' using errcode = '55000';
  end if;

  -- Enable retention purge for this transaction only
  perform set_config('mms.retention_purge_allowed', 'true', true);

  -- Purge change logs for tables matching this retention class (or unclassified change logs under RC-5)
  with eligible_changes as (
    select c.id
    from audit_trail.change_log c
    left join audit_trail.table_retention_policy p
      on p.schema_name = c.schema_name
     and p.table_name = c.table_name
    where (
      (p_retention_class = 'RC-5' and (p.retention_class = 'RC-5' or p.retention_class is null))
      or p.retention_class = p_retention_class
    )
      and c.occurred_at < p_older_than
      and c.tx_id < v_max_sealed_xid
    order by c.id
    limit coalesce(p_max_rows, 1000)
    for update skip locked
  ),
  deleted_changes as (
    delete from audit_trail.change_log c
    using eligible_changes ec
    where c.id = ec.id
    returning c.id
  )
  select count(*) into v_purged_change_logs from deleted_changes;

  -- Purge events matching this retention class
  with eligible_events as (
    select e.id
    from audit_trail.event e
    join audit_trail.event_type t on t.code = e.event_type
    where t.retention_class = p_retention_class
      and e.occurred_at < p_older_than
      and e.tx_id < v_max_sealed_xid
    order by e.id
    limit coalesce(p_max_rows, 1000)
    for update skip locked
  ),
  deleted_events as (
    delete from audit_trail.event e
    using eligible_events ee
    where e.id = ee.id
    returning e.id
  )
  select count(*) into v_purged_events from deleted_events;

  -- Reset retention purge flag
  perform set_config('mms.retention_purge_allowed', 'false', true);

  -- Record retention purge run
  insert into audit_trail.retention_purge_run (
    retention_class, cutoff_time, max_sealed_xid,
    change_log_purged_count, event_purged_count,
    reason, status
  ) values (
    p_retention_class, p_older_than, v_max_sealed_xid,
    v_purged_change_logs, v_purged_events,
    v_reason,
    'completed'
  ) returning id into v_purge_run_id;

  -- Emit regulated operational audit event (audit_trail.retention.purged)
  perform private.emit_event(
    'audit_trail.retention.purged',
    'success',
    'retention_class',
    null,
    null,
    v_reason,
    jsonb_build_object(
      'run_id', v_purge_run_id,
      'retention_class', p_retention_class,
      'cutoff_time', p_older_than,
      'max_sealed_xid', v_max_sealed_xid::text,
      'change_logs_purged', v_purged_change_logs,
      'events_purged', v_purged_events
    )
  );

  return jsonb_build_object(
    'run_id', v_purge_run_id,
    'retention_class', p_retention_class,
    'cutoff_time', p_older_than,
    'max_sealed_xid', v_max_sealed_xid::text,
    'change_logs_purged', v_purged_change_logs,
    'events_purged', v_purged_events
  );
end;
$$;

CREATE OR REPLACE FUNCTION change_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_max_sealed xid8;
begin
  if tg_op = 'DELETE'
     and current_setting('mms.retention_purge_allowed', true) = 'true'
     and private.caller_role() in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator', 'postgres') then
    select max(to_xid) into v_max_sealed from audit_trail.seal;
    if v_max_sealed is not null and old.tx_id < v_max_sealed then
      return old;
    end if;
  end if;
  raise exception 'audit_trail.change_log is append-only';
end;
$$;

CREATE OR REPLACE FUNCTION event_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_max_sealed xid8;
begin
  if tg_op = 'DELETE'
     and current_setting('mms.retention_purge_allowed', true) = 'true'
     and private.caller_role() in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator', 'postgres') then
    select max(to_xid) into v_max_sealed from audit_trail.seal;
    if v_max_sealed is not null and old.tx_id < v_max_sealed then
      return old;
    end if;
  end if;
  raise exception 'audit_trail.event is append-only';
end;
$$;
