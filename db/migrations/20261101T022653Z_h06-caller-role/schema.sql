-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION caller_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  select coalesce(
    nullif(current_setting('role', true), ''),
    current_user::text
  );
$$;

CREATE OR REPLACE FUNCTION is_worker()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  select private.caller_role() = 'worker';
$$;

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
    schema_name, table_name, op, row_id, old_row, new_row, changed_cols,
    actor_id, actor_label, db_role, session_id, auth_method, on_behalf_of, initiated_by,
    request_id, trace_id, source, client_ip, reason
  ) values (
    tg_table_schema, tg_table_name, left(tg_op, 1),
    coalesce(raw_n ->> 'id', raw_o ->> 'id')::uuid,
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
    coalesce(c ->> 'src', case when c = '{}'::jsonb then 'dba' else 'web' end),
    nullif(h ->> 'x-client-ip', '')::inet,
    nullif(current_setting('mms.reason', true), '')
  );
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION deprovision_staff_user(
    p_user_id uuid,
    p_reason text,
    p_details jsonb DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_worker_id uuid;
  v_worker_name text;
  v_revoked_sessions int := 0;
  v_revoked_assignments int := 0;
  v_closed_positions int := 0;
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_user
    from iam.app_user
   where id = p_user_id and kind = 'internal'
     for update;

  if not found then
    raise exception 'staff_user_not_found' using errcode = 'P0002';
  end if;

  if v_user.status = 'deactivated' then
    return jsonb_build_object(
      'user_id', p_user_id,
      'status', 'already_deactivated',
      'deactivated', false
    );
  end if;

  -- Setup actor identity for worker if session or role is worker
  if private.is_worker() then
    select id, display_name into v_worker_id, v_worker_name
      from iam.app_user
     where kind = 'service' and service_name = 'worker' and status = 'active';

    if v_worker_id is null then
      insert into iam.app_user (id, kind, display_name, service_name, status)
      values ('00000000-0000-0000-0000-000000000001', 'service', 'Outbox Worker', 'worker', 'active')
      on conflict (service_name) do update set status = 'active'
      returning id, display_name into v_worker_id, v_worker_name;
    end if;

    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', v_worker_id::text,
        'name', coalesce(v_worker_name, 'worker'),
        'role', 'worker',
        'src', 'job'
      )::text, true);
  else
    v_worker_id := private.uid();
  end if;

  perform set_config('mms.reason', p_reason, true);

  -- 1. Close active and future positions
  update iam.staff_position
     set valid = case
                   when lower(valid) < now() then tstzrange(lower(valid), now())
                   else 'empty'::tstzrange
                 end,
         reason = p_reason
   where user_id = p_user_id
     and not isempty(valid)
     and (upper_inf(valid) or upper(valid) > now());
  get diagnostics v_closed_positions = row_count;

  -- 2. Revoke active role assignments
  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = v_worker_id,
         revoke_reason = p_reason
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_revoked_assignments = row_count;

  -- Count active sessions that will be revoked by user deactivation
  select count(*) into v_revoked_sessions
    from iam.session
   where user_id = p_user_id
     and revoked_at is null;

  -- 3. Transition user status to deactivated
  -- Trigger private.app_user_revoke_sessions automatically revokes all active sessions in iam.session
  update iam.app_user
     set status = 'deactivated'
   where id = p_user_id;

  -- 4. Emit regulated audit event
  perform private.emit_event(
    'auth.user.deactivated',
    'success',
    'app_user',
    p_user_id,
    null,
    p_reason,
    jsonb_build_object(
      'user_id', p_user_id,
      'email', v_user.email,
      'display_name', v_user.display_name,
      'entra_tenant_id', v_user.entra_tenant_id,
      'entra_object_id', v_user.entra_object_id,
      'closed_positions', v_closed_positions,
      'revoked_assignments', v_revoked_assignments,
      'details', p_details
    )
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'status', 'deactivated',
    'deactivated', true,
    'closed_positions', v_closed_positions,
    'revoked_assignments', v_revoked_assignments,
    'revoked_sessions', v_revoked_sessions
  );
end;
$$;

CREATE OR REPLACE FUNCTION document_version_record_scan(
    p_version_id uuid,
    p_status text,
    p_scanner_engine text,
    p_threat_name text DEFAULT NULL,
    p_promoted_path text DEFAULT NULL,
    p_detail jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_version core.document_version;
  v_doc core.document;
  v_req survey.survey_request;
  v_unit_id uuid;
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  if p_status not in ('clean', 'infected', 'error') then
    raise exception 'invalid_scan_status: %', p_status using errcode = '22023';
  end if;

  select * into v_version from core.document_version where id = p_version_id for update;
  if not found then
    raise exception 'version_not_found' using errcode = '22023';
  end if;

  select * into v_doc from core.document where id = v_version.document_id;
  if v_doc.entity_type = 'survey_request' then
    select * into v_req from survey.survey_request where id = v_doc.entity_id;
    v_unit_id := v_req.office_unit_id;
  end if;

  if p_status = 'clean' then
    if v_version.scan_status = 'infected' then
      raise exception 'cannot_mark_infected_document_as_clean' using errcode = '42501';
    end if;

    update core.document_version
       set scan_status = 'clean',
           scanned_at = clock_timestamp(),
           threat_name = null,
           storage_path = coalesce(p_promoted_path, storage_path)
     where id = p_version_id;

    perform private.emit_event(
      'core.document.scan_passed', 'success', 'document_version', p_version_id, v_unit_id, null,
      jsonb_build_object(
        'scanner_engine', p_scanner_engine,
        'sha256', encode(v_version.sha256, 'hex'),
        'byte_size', v_version.byte_size,
        'promoted_path', p_promoted_path
      )
    );
  elsif p_status = 'infected' then
    update core.document_version
       set scan_status = 'infected',
           scanned_at = clock_timestamp(),
           threat_name = p_threat_name
     where id = p_version_id;

    perform private.emit_event(
      'core.document.malware_detected', 'failure', 'document_version', p_version_id, v_unit_id, null,
      jsonb_build_object(
        'scanner_engine', p_scanner_engine,
        'threat_name', p_threat_name,
        'sha256', encode(v_version.sha256, 'hex'),
        'byte_size', v_version.byte_size,
        'quarantine_path', v_version.storage_path
      )
    );
  else
    -- Transient scan error must not overwrite an already definitive clean or infected verdict!
    if v_version.scan_status in ('clean', 'infected') then
      return;
    end if;

    update core.document_version
       set scan_status = 'error',
           scanned_at = clock_timestamp()
     where id = p_version_id;
  end if;

  insert into audit_trail.malware_scan_run (
    version_id, document_id, file_name, sha256, byte_size,
    scanner_engine, status, threat_name, quarantine_path, promoted_path,
    scanned_by, detail
  ) values (
    p_version_id, v_version.document_id, v_version.file_name, v_version.sha256, v_version.byte_size,
    p_scanner_engine, p_status, p_threat_name, v_version.storage_path, p_promoted_path,
    private.caller_role(),
    p_detail
  );
end;
$$;

CREATE OR REPLACE FUNCTION emit_event(
    p_event_type text,
    p_outcome text,
    p_subject_type text,
    p_subject_id uuid,
    p_scope_unit_id uuid,
    p_reason text,
    p_detail jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c jsonb := private.claims();
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  v_reason_required boolean;
  v_reason text := coalesce(p_reason, nullif(current_setting('mms.reason', true), ''));
  v_on_behalf_of uuid := nullif(current_setting('mms.on_behalf_of', true), '')::uuid;
  v_authority_rule_id uuid := coalesce((p_detail ->> 'authority_rule_id')::uuid, nullif(current_setting('mms.authority_rule_id', true), '')::uuid);
  v_actor_title text := coalesce(nullif(current_setting('mms.authority_title', true), ''), c ->> 'title');
  v_actor_grade int := coalesce(nullif(current_setting('mms.authority_grade', true), '')::int, nullif(c ->> 'grade', '')::int);
  v_actor_unit_id uuid := coalesce(nullif(current_setting('mms.authority_unit_id', true), '')::uuid, nullif(c ->> 'org_unit_id', '')::uuid);
  v_pos record;
begin
  select reason_required into v_reason_required
    from audit_trail.event_type
   where code = p_event_type;
  if not found then
    raise exception 'invalid_event_type: %', p_event_type using errcode = '22023';
  end if;

  if v_reason_required and (v_reason is null or btrim(v_reason) = '') then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if v_on_behalf_of is not null and not exists (
    select 1 from party.organization where id = v_on_behalf_of
  ) then
    raise exception 'invalid_on_behalf_of' using errcode = '22023';
  end if;

  if v_actor_title is null or v_actor_grade is null or v_actor_unit_id is null then
    select p.job_title_code, t.grade, p.unit_id
      into v_pos
      from iam.staff_position p
      join iam.job_title t on t.code = p.job_title_code
     where p.user_id = nullif(c ->> 'sub', '')::uuid
       and p.valid @> now()
     limit 1;
    if found then
      v_actor_title := coalesce(v_actor_title, v_pos.job_title_code);
      v_actor_grade := coalesce(v_actor_grade, v_pos.grade);
      v_actor_unit_id := coalesce(v_actor_unit_id, v_pos.unit_id);
    end if;
  end if;

  if coalesce(nullif(c ->> 'role', ''), private.caller_role()) = 'int_sysadmin' then
    v_actor_title := coalesce(v_actor_title, 'System Administrator');
    if v_actor_unit_id is null then
      select id into v_actor_unit_id from core.org_unit where unit_type = 'head_office' limit 1;
    end if;
  end if;

  insert into audit_trail.event (
    event_type, outcome, actor_id, session_id, db_role, auth_method,
    on_behalf_of, initiated_by, actor_title, actor_grade, actor_unit_id,
    authority_rule_id, subject_type, subject_id, scope_unit_id,
    request_id, trace_id, source, client_ip, reason, detail
  ) values (
    p_event_type,
    p_outcome,
    nullif(c ->> 'sub', '')::uuid,
    nullif(c ->> 'sid', '')::uuid,
    coalesce(nullif(c ->> 'role', ''), private.caller_role()),
    c -> 'amr' ->> 0,
    v_on_behalf_of,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    v_actor_title,
    v_actor_grade,
    v_actor_unit_id,
    v_authority_rule_id,
    p_subject_type,
    p_subject_id,
    p_scope_unit_id,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    coalesce(c ->> 'src', 'web'),
    nullif(h ->> 'x-client-ip', '')::inet,
    v_reason,
    p_detail
  );

  perform set_config('mms.authority_rule_id', '', true);
  perform set_config('mms.authority_title', '', true);
  perform set_config('mms.authority_grade', '', true);
  perform set_config('mms.authority_unit_id', '', true);
  perform set_config('mms.reason', '', true);
  perform set_config('mms.on_behalf_of', '', true);
end;
$$;

CREATE OR REPLACE FUNCTION entra_sync_list_staff()
RETURNS TABLE(user_id uuid, entra_tenant_id uuid, entra_object_id uuid, display_name text, email text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entra_tenant_id, u.entra_object_id, u.display_name, u.email, u.status
    from iam.app_user u
   where u.kind = 'internal'
     and u.status in ('active', 'suspended')
     and u.entra_tenant_id is not null
     and u.entra_object_id is not null
   order by u.id;
end;
$$;

CREATE OR REPLACE FUNCTION get_quarantine_scan_target(
    p_version_id uuid
)
RETURNS TABLE(version_id uuid, document_id uuid, entity_type text, entity_id uuid, file_name text, mime_type text, byte_size bigint, sha256 text, storage_path text, scan_status text, threat_name text, created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select
    v.id as version_id,
    v.document_id,
    d.entity_type,
    d.entity_id,
    v.file_name,
    v.mime_type,
    v.byte_size,
    encode(v.sha256, 'hex') as sha256,
    v.storage_path,
    v.scan_status,
    v.threat_name,
    v.created_at
  from core.document_version v
  join core.document d on d.id = v.document_id
  where v.id = p_version_id
  for update;
end;
$$;

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
  if not private.is_worker() then
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
  if not private.is_worker() then
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

CREATE OR REPLACE FUNCTION list_pending_quarantine_scans(
    p_limit integer DEFAULT 50
)
RETURNS TABLE(version_id uuid, document_id uuid, entity_type text, entity_id uuid, file_name text, mime_type text, byte_size bigint, sha256 text, storage_path text, created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select
    v.id as version_id,
    v.document_id,
    d.entity_type,
    d.entity_id,
    v.file_name,
    v.mime_type,
    v.byte_size,
    encode(v.sha256, 'hex') as sha256,
    v.storage_path,
    v.created_at
  from core.document_version v
  join core.document d on d.id = v.document_id
  where v.scan_status = 'pending'
    and v.storage_path like 'quarantine/%'
  order by v.created_at asc
  limit coalesce(p_limit, 50);
end;
$$;

CREATE OR REPLACE FUNCTION record_entra_sync_run(
    p_status text,
    p_users_checked integer,
    p_users_deprovisioned integer,
    p_deprovisioned_user_ids uuid[],
    p_error_message text DEFAULT NULL,
    p_detail jsonb DEFAULT '{}'
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_run_id bigint;
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  insert into audit_trail.entra_sync_run (
    status, users_checked, users_deprovisioned, deprovisioned_user_ids, error_message, detail
  )
  values (
    p_status, p_users_checked, p_users_deprovisioned, coalesce(p_deprovisioned_user_ids, '{}'), p_error_message, p_detail
  )
  returning id into v_run_id;

  return v_run_id;
end;
$$;

CREATE OR REPLACE FUNCTION record_malware_scan_run(
    p_file_name text,
    p_sha256 bytea,
    p_byte_size bigint,
    p_scanner_engine text,
    p_status text,
    p_threat_name text DEFAULT NULL,
    p_quarantine_path text DEFAULT '',
    p_promoted_path text DEFAULT NULL,
    p_scanned_by text DEFAULT NULL,
    p_detail jsonb DEFAULT '{}',
    p_version_id uuid DEFAULT NULL,
    p_document_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  insert into audit_trail.malware_scan_run (
    version_id, document_id, file_name, sha256, byte_size,
    scanner_engine, status, threat_name, quarantine_path, promoted_path,
    scanned_by, detail
  ) values (
    p_version_id, p_document_id, p_file_name, p_sha256, p_byte_size,
    p_scanner_engine, p_status, p_threat_name, p_quarantine_path, p_promoted_path,
    coalesce(p_scanned_by, private.caller_role()), p_detail
  );
end;
$$;
