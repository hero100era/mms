-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION is_worker_or_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  select private.is_worker()
      or coalesce(private.active_role(), '') = 'int_sysadmin';
$$;

REVOKE EXECUTE ON FUNCTION is_worker_or_admin() FROM PUBLIC;

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
  if not private.is_worker_or_admin() then
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
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  if p_status not in ('clean', 'infected', 'error') then
    raise exception 'invalid_scan_status: %', p_status using errcode = '22023';
  end if;

  select * into v_version from core.document_version where id = p_version_id for update;
  if not found then
    raise exception 'version_not_found' using errcode = '22023';
  end if;

  -- One verdict per version. Two concurrent scan requests (a double click, two
  -- workers) both reach this point; the second one blocks on the row lock above
  -- and then sees the verdict the first one committed. Recording it again would
  -- duplicate the audit row and could move a clean version back to error or
  -- overwrite its promoted path.
  if v_version.scan_status = p_status then
    return;
  end if;
  if v_version.scan_status = 'clean' then
    raise exception 'scan_already_recorded' using errcode = '22023';
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

CREATE OR REPLACE FUNCTION entra_sync_list_staff()
RETURNS TABLE(user_id uuid, entra_tenant_id uuid, entra_object_id uuid, display_name text, email text, status text, has_position boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entra_tenant_id, u.entra_object_id, u.display_name, u.email, u.status,
         exists (
           select 1 from iam.staff_position sp
            where sp.user_id = u.id and upper(sp.valid) is null
         ) as has_position
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
  if not private.is_worker_or_admin() then
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
  where v.id = p_version_id;
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
  if not private.is_worker_or_admin() then
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

CREATE OR REPLACE FUNCTION position_proposal_record(
    p_user_id uuid,
    p_entra_job_title text,
    p_entra_department text,
    p_entra_office text,
    p_payload jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_title text;
  v_unit uuid;
  v_id uuid;
begin
  if not (private.is_worker_or_admin() or coalesce(private.active_role(), '') = 'int_hr') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  select * into v_user from iam.app_user
   where id = p_user_id and kind = 'internal' and status = 'active';
  if not found then
    raise exception 'internal_user_not_found';
  end if;

  select t.code into v_title from iam.job_title t
   where t.active and lower(t.code) = lower(btrim(coalesce(p_entra_job_title, '')));
  select u.id into v_unit from core.org_unit u
   where u.active and lower(u.code) = lower(btrim(coalesce(p_entra_office, ''))) limit 1;

  insert into iam.position_proposal (
    user_id, job_title_code, unit_id, entra_job_title, entra_department, entra_office,
    source, source_payload
  )
  values (
    v_user.id, v_title, v_unit,
    nullif(btrim(p_entra_job_title), ''),
    nullif(btrim(p_entra_department), ''),
    nullif(btrim(p_entra_office), ''),
    'entra', coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (user_id) where status = 'pending'
  do update set job_title_code = excluded.job_title_code,
                unit_id = excluded.unit_id,
                entra_job_title = excluded.entra_job_title,
                entra_department = excluded.entra_department,
                entra_office = excluded.entra_office,
                source_payload = excluded.source_payload,
                proposed_at = now()
  returning id into v_id;

  perform private.emit_event(
    'iam.position.proposed', 'success', 'staff_user', v_user.id, v_unit,
    'position proposed from directory attributes',
    jsonb_build_object('proposal_id', v_id, 'job_title_guess', v_title, 'unit_guess', v_unit)
  );
  return v_id;
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
  if not private.is_worker_or_admin() then
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
  -- R1.1/R1.2: a scan-run ledger row may only be written by the worker that
  -- performed the scan (or an explicitly authorised sysadmin). The EXECUTE
  -- grant is a first gate, not the only one: every sibling definer function in
  -- this schema checks the same caller class (ADR-0017).
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

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

GRANT EXECUTE ON FUNCTION is_worker_or_admin() TO int_hr;

GRANT EXECUTE ON FUNCTION is_worker_or_admin() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION is_worker_or_admin() TO worker;
