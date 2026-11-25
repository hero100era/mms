-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION audit_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  raise exception '%.% cannot be truncated', tg_table_schema, tg_table_name;
end;
$$;

ALTER TABLE approved_scanner_engine ENABLE ROW LEVEL SECURITY;

CREATE POLICY approved_scanner_engine_read ON approved_scanner_engine FOR SELECT TO int_compliance, int_sysadmin, worker USING (true);

CREATE OR REPLACE FUNCTION audit_capture()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c     jsonb := private.claims();
  h     jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  raw_o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  raw_n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_raw_key text := coalesce(raw_n ->> 'id', raw_o ->> 'id', raw_n ->> 'code', raw_o ->> 'code');
  v_row_id  uuid := case
    when v_raw_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then v_raw_key::uuid
    else null
  end;
  cols  text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(k.key order by k.key) into cols
      from jsonb_object_keys(raw_n) as k(key)
     where raw_n -> k.key is distinct from raw_o -> k.key
       and k.key not in ('updated_at', 'row_version');
    if cols is null then
      return null;
    end if;
  end if;

  insert into audit_trail.change_log (
    schema_name, table_name, op, row_id, row_key, old_row, new_row, changed_cols,
    actor_id, actor_label, db_role, session_id, auth_method, on_behalf_of, initiated_by,
    request_id, trace_id, source, client_ip, reason
  ) values (
    tg_table_schema, tg_table_name, left(tg_op, 1),
    v_row_id,
    v_raw_key,
    private.audit_redact(tg_table_schema, tg_table_name, raw_o),
    private.audit_redact(tg_table_schema, tg_table_name, raw_n),
    cols,
    nullif(c ->> 'sub', '')::uuid,
    c ->> 'name',
    coalesce(nullif(c ->> 'role', ''), private.caller_role()),
    nullif(c ->> 'sid', '')::uuid,
    c -> 'amr' ->> 0,
    nullif(current_setting('mms.on_behalf_of', true), '')::uuid,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    private.audit_source(),
    nullif(h ->> 'x-client-ip', '')::inet,
    nullif(current_setting('mms.reason', true), '')
  );
  return null;
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
     and private.caller_role() in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator') then
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
     and private.caller_role() in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator') then
    select max(to_xid) into v_max_sealed from audit_trail.seal;
    if v_max_sealed is not null and old.tx_id < v_max_sealed then
      return old;
    end if;
  end if;
  raise exception 'audit_trail.event is append-only';
end;
$$;

CREATE OR REPLACE FUNCTION job_poll(
    p_limit integer DEFAULT 10
)
RETURNS TABLE(id uuid, kind text, payload jsonb, attempts integer, enqueued_by uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  -- A job that another instance has already claimed (`processing`) or finished
  -- (`done`) must never be handed out twice: `job_begin` has already bumped
  -- `attempts` and set the worker context, so re-processing would re-send the
  -- invite mail and double the audit attribution. Only terminal states are
  -- retried, and `failed` is terminal here (a human re-queues it).
  --
  -- R7.2: durable outbox leasing with `FOR UPDATE SKIP LOCKED`.
  -- Reclaims orphaned jobs whose lease has expired.
  return query
  select o.id, o.kind, o.payload, o.attempts, o.enqueued_by
    from core.outbox o
   where ((o.status = 'pending' and o.next_at <= now())
          or (o.status = 'processing' and o.lease_expires_at is not null and o.lease_expires_at < now()))
   order by o.next_at, o.created_at
   limit coalesce(p_limit, 10)
     for update skip locked;
end;
$$;

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
  if private.caller_role() not in ('audit_sealer', 'worker', 'int_sysadmin') then
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
  if private.caller_role() not in ('audit_sealer', 'worker', 'int_sysadmin') then
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

CREATE OR REPLACE FUNCTION upload_mark_verdict(
    p_upload_id uuid,
    p_state text,
    p_engine text,
    p_threat text DEFAULT NULL,
    p_doc_version_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_current_state text;
begin
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;
  if p_state not in ('pending_scan', 'clean', 'infected', 'error', 'abandoned') then
    raise exception 'invalid_upload_verdict_state' using errcode = '22023';
  end if;

  select upload_state into v_current_state
    from core.upload
   where id = p_upload_id
     for update;

  if not found then
    raise exception 'upload_not_found' using errcode = '42501';
  end if;
  if v_current_state in ('clean', 'infected', 'abandoned') then
    raise exception 'upload_state_terminal: %', v_current_state using errcode = '22023';
  end if;
  if v_current_state not in ('uploaded', 'pending_scan', 'error') then
    raise exception 'upload_state_transition_invalid: % -> %', v_current_state, p_state using errcode = '22023';
  end if;

  update core.upload
     set upload_state = p_state,
         scanner_engine = p_engine,
         threat_name = p_threat,
         scanned_at = clock_timestamp(),
         document_version_id = case when p_state = 'clean' then p_doc_version_id else null end,
         updated_at = clock_timestamp(),
         updated_by = coalesce(private.uid(), updated_by)
   where id = p_upload_id;
end;
$$;

-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

REVOKE SELECT ON TABLE flag FROM ext_user;

ALTER TABLE administration_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY administration_type_read ON administration_type FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE breakdown_template DROP CONSTRAINT breakdown_template_code_key;

ALTER TABLE breakdown_template ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER breakdown_template_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON breakdown_template
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY breakdown_template_read ON breakdown_template FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE breakdown_template_node DROP CONSTRAINT breakdown_template_node_parent_node_id_fkey;

ALTER TABLE breakdown_template_node
ADD CONSTRAINT uq_template_node_template_id_id UNIQUE (template_id, id);

ALTER TABLE core.breakdown_template_node
ADD CONSTRAINT fk_template_node_parent_same_template FOREIGN KEY (template_id, parent_node_id) REFERENCES core.breakdown_template_node (template_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE core.breakdown_template_node VALIDATE CONSTRAINT fk_template_node_parent_same_template;

ALTER TABLE breakdown_template_node ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER breakdown_template_node_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON breakdown_template_node
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY breakdown_template_node_read ON breakdown_template_node FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);





ALTER TABLE breakdown_template_node_particular ENABLE ROW LEVEL SECURITY;

CREATE POLICY breakdown_template_node_particular_read ON breakdown_template_node_particular FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE certificate_action ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_action_read ON certificate_action FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE certificate_category ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_category_read ON certificate_category FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE certificate_internal_category ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_internal_category_read ON certificate_internal_category FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE certificate_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_status_read ON certificate_status FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE certificate_survey_pool ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_survey_pool_read ON certificate_survey_pool FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE certificate_template ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_template_read ON certificate_template FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);









ALTER TABLE certificate_validity_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_validity_type_read ON certificate_validity_type FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE checklist_item ENABLE ROW LEVEL SECURITY;

CREATE POLICY checklist_item_read ON checklist_item FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);







ALTER TABLE checklist_item_particular ALTER COLUMN checklist_item_id TYPE integer USING checklist_item_id::integer;

ALTER TABLE checklist_item_particular ENABLE ROW LEVEL SECURITY;

CREATE POLICY checklist_item_particular_read ON checklist_item_particular FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE checklist_result ENABLE ROW LEVEL SECURITY;

CREATE POLICY checklist_result_read ON checklist_result FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE checklist_section ENABLE ROW LEVEL SECURITY;

CREATE POLICY checklist_section_read ON checklist_section FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE class_notation ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER class_notation_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON class_notation
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY class_notation_read ON class_notation FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);







ALTER TABLE class_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY class_status_read ON class_status FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE classification_society ENABLE ROW LEVEL SECURITY;

CREATE POLICY classification_society_read ON classification_society FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE comment_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY comment_status_read ON comment_status FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE comment_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY comment_type_read ON comment_type FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE flag ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER flag_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON flag
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY flag_read ON flag FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE flag_cert_authorization ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER flag_cert_authorization_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON flag_cert_authorization
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY flag_cert_authorization_read ON flag_cert_authorization FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);





ALTER TABLE flag_survey_authorization ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER flag_survey_authorization_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON flag_survey_authorization
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY flag_survey_authorization_read ON flag_survey_authorization FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);





ALTER TABLE notation_compatibility ENABLE ROW LEVEL SECURITY;

CREATE POLICY notation_compatibility_read ON notation_compatibility FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);





ALTER TABLE notation_group ENABLE ROW LEVEL SECURITY;

CREATE POLICY notation_group_read ON notation_group FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_worker_admin_all ON outbox TO int_sysadmin, worker USING (true) WITH CHECK (true);

ALTER TABLE report_template ENABLE ROW LEVEL SECURITY;

CREATE POLICY report_template_read ON report_template FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE ship_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_status_read ON ship_status FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE society_group_rendering ENABLE ROW LEVEL SECURITY;

CREATE POLICY society_group_rendering_read ON society_group_rendering FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);





ALTER TABLE survey_audit_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_audit_status_read ON survey_audit_status FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE survey_audit_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_audit_type_read ON survey_audit_type FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE survey_documentation ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_documentation_read ON survey_documentation FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE survey_pool ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER survey_pool_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON survey_pool
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE POLICY survey_pool_read ON survey_pool FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);





ALTER TABLE survey_preparation ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_preparation_read ON survey_preparation FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE survey_preparation_section ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_preparation_section_read ON survey_preparation_section FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);



ALTER TABLE vessel_type_iacs ENABLE ROW LEVEL SECURITY;

CREATE POLICY vessel_type_iacs_read ON vessel_type_iacs FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE vessel_type_mms ENABLE ROW LEVEL SECURITY;

CREATE POLICY vessel_type_mms_read ON vessel_type_mms FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

GRANT SELECT (code, fullname, is_active, is_hssc, name) ON TABLE flag TO ext_user;

-- ===== schema: audit_trail  (pgschema 1.14.1) =====

set local search_path = audit_trail;

REVOKE INSERT, SELECT ON TABLE malware_scan_run FROM int_coordinator;

REVOKE INSERT, SELECT ON TABLE malware_scan_run FROM int_manager;

ALTER TABLE change_log ADD COLUMN row_key text;

CREATE OR REPLACE TRIGGER change_log_no_truncate
    BEFORE TRUNCATE ON change_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();



CREATE OR REPLACE TRIGGER crypto_shred_key_no_truncate
    BEFORE TRUNCATE ON crypto_shred_key
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

CREATE OR REPLACE TRIGGER entra_sync_run_no_truncate
    BEFORE TRUNCATE ON entra_sync_run
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

CREATE OR REPLACE TRIGGER event_no_truncate
    BEFORE TRUNCATE ON event
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

ALTER TABLE event_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_type_read ON event_type FOR SELECT TO audit_sealer, ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer, worker USING (true);

ALTER TABLE excluded_column ENABLE ROW LEVEL SECURITY;

CREATE POLICY excluded_column_read ON excluded_column FOR SELECT TO audit_sealer, int_compliance, int_sysadmin, worker USING (true);

CREATE OR REPLACE TRIGGER malware_scan_run_no_truncate
    BEFORE TRUNCATE ON malware_scan_run
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

ALTER POLICY malware_scan_run_insert ON malware_scan_run TO int_sysadmin, worker;

CREATE OR REPLACE TRIGGER reconciliation_discrepancy_no_truncate
    BEFORE TRUNCATE ON reconciliation_discrepancy
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

CREATE OR REPLACE TRIGGER reconciliation_run_no_truncate
    BEFORE TRUNCATE ON reconciliation_run
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

CREATE OR REPLACE TRIGGER retention_purge_run_no_truncate
    BEFORE TRUNCATE ON retention_purge_run
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

CREATE OR REPLACE TRIGGER seal_no_truncate
    BEFORE TRUNCATE ON seal
    FOR EACH STATEMENT
    EXECUTE FUNCTION private.audit_no_truncate();

GRANT SELECT ON TABLE malware_scan_run TO audit_sealer;

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

REVOKE USAGE ON SEQUENCE class_number_seq FROM ext_user;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_auditor;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_compliance;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_coordinator;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_finance;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_hr;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_manager;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_surveyor;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_sysadmin;

REVOKE USAGE ON SEQUENCE class_number_seq FROM int_viewer;

ALTER TABLE ship
ADD CONSTRAINT ship_class_number_uk UNIQUE (class_number);

CREATE OR REPLACE TRIGGER ship_breakdown_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON ship_breakdown
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

ALTER TABLE ship_breakdown_node DROP CONSTRAINT ship_breakdown_node_parent_node_id_fkey;

ALTER TABLE ship_breakdown_node
ADD CONSTRAINT uq_ship_node_breakdown_id_id UNIQUE (ship_breakdown_id, id);

ALTER TABLE fleet.ship_breakdown_node
ADD CONSTRAINT fk_ship_node_parent_same_breakdown FOREIGN KEY (ship_breakdown_id, parent_node_id) REFERENCES fleet.ship_breakdown_node (ship_breakdown_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE fleet.ship_breakdown_node VALIDATE CONSTRAINT fk_ship_node_parent_same_breakdown;

CREATE OR REPLACE TRIGGER ship_breakdown_node_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON ship_breakdown_node
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();
