-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) TO PUBLIC;

REVOKE EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) FROM audit_sealer;

REVOKE EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) FROM int_sysadmin;

REVOKE EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) FROM worker;

DROP FUNCTION IF EXISTS purge_sealed_audit_records(text, timestamptz, integer);

CREATE OR REPLACE FUNCTION purge_sealed_audit_records(
    p_retention_class text,
    p_older_than timestamptz,
    p_max_rows integer DEFAULT 1000,
    p_reason text DEFAULT 'Lifecycle retention purge of sealed audit records'
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

REVOKE EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer, p_reason text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION crypto_shred_key_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'audit_trail.crypto_shred_key records cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    if old.key_status = 'shredded' then
      raise exception 'shredded keys cannot be modified or restored';
    end if;
    if new.subject_id <> old.subject_id then
      raise exception 'subject_id is immutable';
    end if;
    if old.key_status = 'active' and new.key_status not in ('active', 'shredded') then
      raise exception 'crypto_shred_key status can only transition to shredded';
    end if;
    return new;
  end if;
  return new;
end;
$$;

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
  v_actor_id uuid := coalesce(private.uid(), nullif(current_setting('mms.actor_id', true), '')::uuid);
begin
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

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer, p_reason text) TO audit_sealer;

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer, p_reason text) TO worker;
