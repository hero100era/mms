-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION is_emergency()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  select private.caller_role() = 'mms_emergency';
$$;

REVOKE EXECUTE ON FUNCTION is_emergency() FROM PUBLIC;

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
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
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

GRANT EXECUTE ON FUNCTION is_emergency() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION is_emergency() TO mms_emergency;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

ALTER TABLE document
ADD CONSTRAINT document_logical_uk UNIQUE (entity_type, entity_id, doc_type);

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

REVOKE EXECUTE ON FUNCTION create_external_user(p_email text, p_display_name text, p_reason text) FROM int_viewer;

REVOKE EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) FROM ext_user;

REVOKE EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) FROM int_compliance;

REVOKE EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) FROM int_viewer;

REVOKE EXECUTE ON FUNCTION document_version_record_scan(p_version_id uuid, p_status text, p_scanner_engine text, p_threat_name text, p_promoted_path text, p_detail jsonb) FROM int_coordinator;

REVOKE EXECUTE ON FUNCTION document_version_record_scan(p_version_id uuid, p_status text, p_scanner_engine text, p_threat_name text, p_promoted_path text, p_detail jsonb) FROM int_manager;

REVOKE EXECUTE ON FUNCTION invite_external_user(p_user_id uuid, p_reason text) FROM int_viewer;

CREATE OR REPLACE FUNCTION document_create_version(
    p_entity_type text,
    p_entity_id uuid,
    p_doc_type text,
    p_title text,
    p_file_name text,
    p_mime_type text,
    p_byte_size bigint,
    p_sha256 bytea,
    p_storage_path text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_doc_id uuid;
  v_rev int;
  v_version_id uuid;
  v_req survey.survey_request;
  v_role text := private.active_role();
begin
  if p_entity_type = 'survey_request' then
    select * into v_req from survey.survey_request where id = p_entity_id;
    if not found then
      raise exception 'survey_request_not_found' using errcode = '22023';
    end if;
    if v_role = 'ext_user' then
      if not (v_req.org_id = any (private.my_org_ids())) then
        raise exception 'unauthorized' using errcode = '42501';
      end if;
    elsif v_role in ('int_viewer', 'int_compliance') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    else
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
    if v_req.status = 'rejected' then
      raise exception 'invalid_state: cannot attach document to rejected request' using errcode = '22023';
    end if;
  else
    raise exception 'unsupported_entity_type: %', p_entity_type using errcode = '22023';
  end if;

  if p_sha256 is null or octet_length(p_sha256) <> 32 then
    raise exception 'sha256_required_32_bytes' using errcode = '22023';
  end if;

  -- R2.1: create-or-find the logical document atomically. ON CONFLICT takes a
  -- row lock on an existing document, so two concurrent first uploads resolve
  -- to one logical document. The title belongs to the logical document, so a
  -- later revision may rename it without creating a second document.
  insert into core.document (entity_type, entity_id, doc_type, title, created_by)
  values (p_entity_type, p_entity_id, p_doc_type, p_title, private.uid())
  on conflict (entity_type, entity_id, doc_type) do update
     set title = excluded.title
   where core.document.title is distinct from excluded.title
  returning id into v_doc_id;

  -- R2.2: serialise revision allocation for this document. The lock is held
  -- until commit, so concurrent callers cannot both read the same max(revision_no).
  select id into v_doc_id from core.document where id = v_doc_id for update;

  select coalesce(max(revision_no), 0) + 1 into v_rev
    from core.document_version
   where document_id = v_doc_id;

  -- A duplicate revision should be impossible while the lock is held. If one
  -- still reaches unique(document_id, revision_no), return a stable domain
  -- error rather than leaking a raw 23505 to the caller.
  begin
    insert into core.document_version (
      document_id, revision_no, storage_path, file_name, mime_type, byte_size, sha256,
      scan_status, scanned_at, created_by
    ) values (
      v_doc_id, v_rev, p_storage_path, p_file_name, p_mime_type, p_byte_size, p_sha256,
      case when p_storage_path like 'quarantine/%' then 'pending' else 'clean' end,
      case when p_storage_path like 'quarantine/%' then null else clock_timestamp() end,
      private.uid()
    ) returning id into v_version_id;
  exception
    when unique_violation then
      raise exception 'document_revision_conflict' using errcode = '40001';
  end;

  perform private.emit_event(
    'core.document.created', 'success', 'document_version', v_version_id, v_req.office_unit_id, null,
    jsonb_build_object(
      'document_id', v_doc_id,
      'revision_no', v_rev,
      'file_name', p_file_name,
      'mime_type', p_mime_type,
      'byte_size', p_byte_size,
      'sha256', encode(p_sha256, 'hex')
    )
  );

  return v_version_id;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_reenable_break_glass(
    p_user_id uuid,
    p_operator text,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed int;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'operator_required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.break_glass_account
     set enabled = true,
         activated_at = null,
         valid_until = null,
         reason = null
   where user_id = p_user_id
     and not enabled;
  get diagnostics v_changed = rowcount;
  return v_changed > 0;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_revoke_assignment(
    p_assignment_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_changed boolean;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select user_id into v_user from iam.role_assignment where id = p_assignment_id;
  if not found then
    raise exception 'assignment_not_found' using errcode = '42501';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = v_user,
         revoke_reason = 'break_glass: ' || btrim(p_reason),
         valid = tstzrange(lower(valid), least(now(), upper(valid)), '[)')
   where id = p_assignment_id
     and revoked_at is null;
  get diagnostics v_changed = rowcount;
  return v_changed > 0;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_revoke_sessions(
    p_user_id uuid,
    p_reason text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed int;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.session
     set revoked_at = now(), revoke_reason = 'break_glass: ' || btrim(p_reason)
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_changed = rowcount;
  return v_changed;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_suspend_user(
    p_user_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed boolean;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.app_user
     set status = 'suspended'
   where id = p_user_id
     and status <> 'suspended';
  get diagnostics v_changed = rowcount;
  return v_changed;
end;
$$;
