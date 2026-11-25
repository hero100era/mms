
create function private.document_version_record_scan(
  p_version_id uuid,
  p_status text,
  p_scanner_engine text,
  p_threat_name text default null,
  p_promoted_path text default null,
  p_detail jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  if p_status in ('clean', 'infected') and not private.is_approved_scanner(p_scanner_engine) then
    raise exception 'unapproved_scanner_engine' using errcode = '42501';
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
           scanner_engine = p_scanner_engine,
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
           threat_name = p_threat_name,
           scanner_engine = p_scanner_engine
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
           scanned_at = clock_timestamp(),
           scanner_engine = p_scanner_engine
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

create function private.list_pending_quarantine_scans(p_limit int default 50)
returns table (
  version_id uuid,
  document_id uuid,
  entity_type text,
  entity_id uuid,
  file_name text,
  mime_type text,
  byte_size bigint,
  sha256 text,
  storage_path text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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

create function private.get_quarantine_scan_target(p_version_id uuid)
returns table (
  version_id uuid,
  document_id uuid,
  entity_type text,
  entity_id uuid,
  file_name text,
  mime_type text,
  byte_size bigint,
  sha256 text,
  storage_path text,
  scan_status text,
  threat_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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

create function private.record_malware_scan_run(
  p_file_name text,
  p_sha256 bytea,
  p_byte_size bigint,
  p_scanner_engine text,
  p_status text,
  p_threat_name text default null,
  p_quarantine_path text default '',
  p_promoted_path text default null,
  p_scanned_by text default null,
  p_detail jsonb default '{}'::jsonb,
  p_version_id uuid default null,
  p_document_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

revoke all on function private.document_version_record_scan(uuid, text, text, text, text, jsonb) from public;
revoke all on function private.list_pending_quarantine_scans(int) from public;
revoke all on function private.get_quarantine_scan_target(uuid) from public;
revoke all on function private.record_malware_scan_run(text, bytea, bigint, text, text, text, text, text, text, jsonb, uuid, uuid) from public;

-- H-05: the scan verdict is recorded only by the worker that performed the scan.
-- `document_version_record_scan` moves the version out of quarantine atomically
-- with its status, so no staff role needs a second, independent promotion path
-- (`api.document_version_promote` pointed at a clean path would otherwise let a
-- caller assert a verdict for a file that was never scanned).
grant execute on function private.document_version_record_scan(uuid, text, text, text, text, jsonb) to worker, int_sysadmin;
grant execute on function private.list_pending_quarantine_scans(int) to worker, int_sysadmin;
grant execute on function private.get_quarantine_scan_target(uuid) to worker, int_sysadmin;
grant execute on function private.record_malware_scan_run(text, bytea, bigint, text, text, text, text, text, text, jsonb, uuid, uuid) to worker, int_sysadmin;

-- ADR-0023 §8 / R7.3: a scan verdict may only be recorded by a scanner this
-- deployment actually runs. `p_scanner_engine` was free text, so a caller could
-- name an engine that does not exist (or "mock") and have an unscanned file
-- marked clean. The allowlist is data so operations can retire an engine
-- without a code change, and the helper keeps the policy in one reviewed place.
create table private.approved_scanner_engine (
  engine text primary key,
  description text not null,
  -- A mock engine can never approve a production document; the flag exists so
  -- the seed can name it honestly and a test can prove the production path
  -- refuses it rather than relying on the name.
  production boolean not null default true,
  constraint approved_scanner_engine_engine_ck check (btrim(engine) <> '')
);

alter table private.approved_scanner_engine enable row level security;

create policy approved_scanner_engine_read on private.approved_scanner_engine
  for select to worker, int_sysadmin, int_compliance
  using (true);

create function private.is_approved_scanner(p_engine text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from private.approved_scanner_engine e
     where e.engine = p_engine
       and e.production = true
  );
$$;

revoke all on function private.is_approved_scanner(text) from public;
grant execute on function private.is_approved_scanner(text) to web_anon, worker;

create function private.upload_prepare(
  p_upload_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_doc_type text,
  p_file_name text,
  p_quarantine_path text,
  p_expires_at timestamptz,
  p_created_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if not private.is_worker() then
    v_actor := private.uid();
    if v_actor is null then
      raise exception 'authentication_required' using errcode = '42501';
    end if;
  else
    v_actor := coalesce(p_created_by, private.uid());
  end if;

  insert into core.upload (
    id, entity_type, entity_id, doc_type, file_name, quarantine_path,
    upload_state, expires_at, created_by
  ) values (
    p_upload_id, p_entity_type, p_entity_id, p_doc_type, p_file_name, p_quarantine_path,
    'prepared', p_expires_at, v_actor
  );
end;
$$;

create function private.upload_get_for_finalize(p_upload_id uuid)
returns table (
  id uuid,
  entity_type text,
  entity_id uuid,
  doc_type text,
  file_name text,
  quarantine_path text,
  upload_state text,
  created_by uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entity_type, u.entity_id, u.doc_type, u.file_name,
         u.quarantine_path, u.upload_state, u.created_by
    from core.upload u
   where u.id = p_upload_id;
end;
$$;

create function private.upload_mark_uploaded(
  p_upload_id uuid,
  p_sha256 bytea,
  p_byte_size bigint,
  p_mime_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if not private.is_worker() and private.uid() is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  update core.upload
     set upload_state = 'uploaded',
         sha256 = p_sha256,
         byte_size = p_byte_size,
         mime_type = p_mime_type,
         updated_at = clock_timestamp(),
         updated_by = coalesce(private.uid(), updated_by)
   where id = p_upload_id
     and upload_state = 'prepared'
     and (private.is_worker() or created_by = private.uid());

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'upload_not_found_or_invalid_state' using errcode = '42501';
  end if;
end;
$$;

create function private.upload_mark_verdict(
  p_upload_id uuid,
  p_state text,
  p_engine text,
  p_threat text default null,
  p_doc_version_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create function private.quarantine_sweep_expired(
  p_retention_interval interval default interval '24 hours'
)
returns table (
  upload_id uuid,
  quarantine_path text,
  sha256 text,
  byte_size bigint,
  upload_state text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  with expired as (
    select u.id, u.quarantine_path, encode(u.sha256, 'hex') as sha256, u.byte_size, u.upload_state, u.created_by
      from core.upload u
     where u.upload_state in ('prepared', 'uploaded', 'pending_scan', 'error')
       and (u.expires_at < clock_timestamp() or u.created_at < clock_timestamp() - p_retention_interval)
     for update skip locked
  ),
  updated as (
    update core.upload u
       set upload_state = 'abandoned',
           updated_at = clock_timestamp(),
           updated_by = coalesce(private.uid(), (select created_by from expired where id = u.id))
      from expired e
     where u.id = e.id
     returning u.id, u.quarantine_path, encode(u.sha256, 'hex') as sha256, u.byte_size, u.upload_state
  )
  select * from updated;
end;
$$;

revoke all on function private.upload_prepare(uuid, text, uuid, text, text, text, timestamptz, uuid) from public;
revoke all on function private.upload_get_for_finalize(uuid) from public;
revoke all on function private.upload_mark_uploaded(uuid, bytea, bigint, text) from public;
revoke all on function private.upload_mark_verdict(uuid, text, text, text, uuid) from public;
revoke all on function private.quarantine_sweep_expired(interval) from public;

grant execute on function private.upload_prepare(uuid, text, uuid, text, text, text, timestamptz, uuid) to ext_user, int_surveyor, int_auditor, int_coordinator, int_manager, int_sysadmin, worker;
grant execute on function private.upload_get_for_finalize(uuid) to worker, int_sysadmin;
grant execute on function private.upload_mark_uploaded(uuid, bytea, bigint, text) to ext_user, int_surveyor, int_auditor, int_coordinator, int_manager, int_sysadmin, worker;
grant execute on function private.upload_mark_verdict(uuid, text, text, text, uuid) to worker, int_sysadmin;
grant execute on function private.quarantine_sweep_expired(interval) to worker, int_sysadmin;

