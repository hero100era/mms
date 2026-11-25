-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

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
  where v.id = p_version_id;
end;
$$;
