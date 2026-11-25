-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

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
    if new.key_status <> 'shredded' then
      raise exception 'crypto_shred_key status can only transition to shredded';
    end if;
    if new.subject_id <> old.subject_id then
      raise exception 'subject_id is immutable';
    end if;
    return new;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION purge_sealed_audit_records(
    p_retention_class text,
    p_older_than timestamptz,
    p_max_rows integer DEFAULT 1000
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

  -- Purge change logs for tables matching this retention class
  with eligible_changes as (
    select c.id
    from audit_trail.change_log c
    join audit_trail.table_retention_policy p
      on p.schema_name = c.schema_name
     and p.table_name = c.table_name
    where p.retention_class = p_retention_class
      and c.occurred_at < p_older_than
      and c.tx_id <= v_max_sealed_xid
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
      and e.tx_id <= v_max_sealed_xid
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
    'Lifecycle retention purge of sealed audit records',
    'completed'
  ) returning id into v_purge_run_id;

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

CREATE OR REPLACE FUNCTION retention_purge_run_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  raise exception 'audit_trail.retention_purge_run is append-only';
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
  v_actor_id uuid := nullif(current_setting('mms.actor_id', true), '')::uuid;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'shred_reason_required' using errcode = '22023';
  end if;

  select key_status into v_status
  from audit_trail.crypto_shred_key
  where subject_id = p_subject_id
  for update;

  if not found then
    raise exception 'crypto_shred_key_not_found: %', p_subject_id using errcode = '22023';
  end if;

  if v_status = 'shredded' then
    return false;
  end if;

  update audit_trail.crypto_shred_key
  set key_status = 'shredded',
      encrypted_key = 'SHREDDED_ZEROIZED_' || repeat('0', 64),
      shredded_at = clock_timestamp(),
      shredded_by = coalesce(v_actor_id, private.uid()),
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

REVOKE EXECUTE ON FUNCTION crypto_shred_key_guard() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION retention_purge_run_append_only() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION shred_subject_key(p_subject_id uuid, p_reason text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION change_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if tg_op = 'DELETE' and current_setting('mms.retention_purge_allowed', true) = 'true' then
    return old;
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
begin
  if tg_op = 'DELETE' and current_setting('mms.retention_purge_allowed', true) = 'true' then
    return old;
  end if;
  raise exception 'audit_trail.event is append-only';
end;
$$;

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) TO audit_sealer;

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION purge_sealed_audit_records(p_retention_class text, p_older_than timestamp with time zone, p_max_rows integer) TO worker;

GRANT EXECUTE ON FUNCTION shred_subject_key(p_subject_id uuid, p_reason text) TO audit_sealer;

GRANT EXECUTE ON FUNCTION shred_subject_key(p_subject_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION shred_subject_key(p_subject_id uuid, p_reason text) TO worker;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE TABLE IF NOT EXISTS crypto_shred_key (
    subject_id uuid,
    key_status text DEFAULT 'active' NOT NULL,
    algorithm text DEFAULT 'AES-256-GCM' NOT NULL,
    encrypted_key text NOT NULL,
    key_fingerprint text NOT NULL,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    shredded_at timestamptz,
    shredded_by uuid,
    shred_reason text,
    CONSTRAINT crypto_shred_key_pk PRIMARY KEY (subject_id),
    CONSTRAINT crypto_shred_key_status_ck CHECK (key_status IN ('active'::text, 'shredded'::text))
);

CREATE INDEX IF NOT EXISTS crypto_shred_key_status_ix ON crypto_shred_key (key_status);

ALTER TABLE crypto_shred_key ENABLE ROW LEVEL SECURITY;

CREATE POLICY crypto_shred_key_all ON crypto_shred_key TO audit_sealer, int_sysadmin, worker USING (true) WITH CHECK (true);

CREATE POLICY crypto_shred_key_read ON crypto_shred_key FOR SELECT TO audit_sealer, int_compliance, int_sysadmin, worker USING (true);

CREATE TABLE IF NOT EXISTS retention_class (
    class_code text,
    name text NOT NULL,
    description text NOT NULL,
    statutory_retention_years integer,
    active_db_retention_years integer,
    disposition_policy text NOT NULL,
    requires_worm boolean DEFAULT true NOT NULL,
    crypto_shred_eligible boolean DEFAULT false NOT NULL,
    CONSTRAINT retention_class_pk PRIMARY KEY (class_code),
    CONSTRAINT retention_class_disposition_ck CHECK (disposition_policy IN ('cold_archive'::text, 'cold_immutable'::text, 'seal_and_worm'::text, 'perpetual'::text))
);

ALTER TABLE retention_class ENABLE ROW LEVEL SECURITY;

CREATE POLICY retention_class_read ON retention_class FOR SELECT TO audit_sealer, ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer, worker USING (true);

CREATE TABLE IF NOT EXISTS retention_purge_run (
    id bigint GENERATED ALWAYS AS IDENTITY,
    executed_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    executed_by text DEFAULT SESSION_USER NOT NULL,
    retention_class text NOT NULL,
    cutoff_time timestamptz NOT NULL,
    max_sealed_xid xid8 NOT NULL,
    change_log_purged_count integer NOT NULL,
    event_purged_count integer NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    CONSTRAINT retention_purge_run_pk PRIMARY KEY (id),
    CONSTRAINT retention_purge_run_class_fk FOREIGN KEY (retention_class) REFERENCES retention_class (class_code),
    CONSTRAINT retention_purge_run_status_ck CHECK (status IN ('completed'::text, 'failed'::text))
);

CREATE INDEX IF NOT EXISTS retention_purge_run_time_ix ON retention_purge_run (executed_at);

ALTER TABLE retention_purge_run ENABLE ROW LEVEL SECURITY;

CREATE POLICY retention_purge_run_insert ON retention_purge_run FOR INSERT TO audit_sealer, int_sysadmin, worker WITH CHECK (true);

CREATE POLICY retention_purge_run_read ON retention_purge_run FOR SELECT TO audit_sealer, int_compliance, int_sysadmin, worker USING (true);

CREATE TABLE IF NOT EXISTS table_retention_policy (
    schema_name text,
    table_name text,
    retention_class text NOT NULL,
    description text NOT NULL,
    CONSTRAINT table_retention_policy_pk PRIMARY KEY (schema_name, table_name),
    CONSTRAINT table_retention_policy_fk FOREIGN KEY (retention_class) REFERENCES retention_class (class_code)
);

ALTER TABLE table_retention_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY table_retention_policy_read ON table_retention_policy FOR SELECT TO audit_sealer, int_compliance, int_manager, int_sysadmin, worker USING (true);

CREATE OR REPLACE TRIGGER crypto_shred_key_guard
    BEFORE UPDATE OR DELETE ON crypto_shred_key
    FOR EACH ROW
    EXECUTE FUNCTION private.crypto_shred_key_guard();

CREATE OR REPLACE TRIGGER retention_purge_run_append_only
    BEFORE UPDATE OR DELETE ON retention_purge_run
    FOR EACH ROW
    EXECUTE FUNCTION private.retention_purge_run_append_only();

ALTER TABLE event_type
ADD COLUMN retention_class text CONSTRAINT event_type_retention_class_fk REFERENCES retention_class (class_code);

GRANT INSERT, SELECT, UPDATE ON TABLE crypto_shred_key TO audit_sealer;

GRANT SELECT ON TABLE crypto_shred_key TO int_compliance;

GRANT INSERT, SELECT, UPDATE ON TABLE crypto_shred_key TO int_sysadmin;

GRANT INSERT, SELECT, UPDATE ON TABLE crypto_shred_key TO worker;

GRANT SELECT ON TABLE retention_class TO audit_sealer;

GRANT SELECT ON TABLE retention_class TO ext_user;

GRANT SELECT ON TABLE retention_class TO int_auditor;

GRANT SELECT ON TABLE retention_class TO int_compliance;

GRANT SELECT ON TABLE retention_class TO int_coordinator;

GRANT SELECT ON TABLE retention_class TO int_finance;

GRANT SELECT ON TABLE retention_class TO int_hr;

GRANT SELECT ON TABLE retention_class TO int_manager;

GRANT SELECT ON TABLE retention_class TO int_surveyor;

GRANT SELECT ON TABLE retention_class TO int_sysadmin;

GRANT SELECT ON TABLE retention_class TO int_viewer;

GRANT SELECT ON TABLE retention_class TO worker;

GRANT INSERT, SELECT ON TABLE retention_purge_run TO audit_sealer;

GRANT SELECT ON TABLE retention_purge_run TO int_compliance;

GRANT INSERT, SELECT ON TABLE retention_purge_run TO int_sysadmin;

GRANT INSERT, SELECT ON TABLE retention_purge_run TO worker;

GRANT SELECT ON TABLE table_retention_policy TO audit_sealer;

GRANT SELECT ON TABLE table_retention_policy TO int_compliance;

GRANT SELECT ON TABLE table_retention_policy TO int_manager;

GRANT SELECT ON TABLE table_retention_policy TO int_sysadmin;

GRANT SELECT ON TABLE table_retention_policy TO worker;
