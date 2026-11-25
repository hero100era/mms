-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

REVOKE EXECUTE ON FUNCTION audit_no_truncate() FROM PUBLIC;

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

-- ===== schema: audit_trail  (pgschema 1.14.1) =====

set local search_path = audit_trail;

REVOKE SELECT ON TABLE change_log FROM int_manager;

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
        email = coalesce(excluded.email, iam.app_user.email)
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

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION break_glass_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select coalesce(
           (select jsonb_build_object(
                     'label', b.label,
                     'enabled', b.enabled,
                     'dormant', not exists (
                         select 1 from iam.role_assignment a
                          where a.user_id = b.user_id
                            and a.source = 'break_glass'
                            and a.revoked_at is null
                            and a.valid && tstzrange(now(), null, '[)')),
                     'valid_until', b.valid_until,
                     'reason', b.reason,
                     'last_drill_at', b.last_drill_at,
                     'drill_overdue', b.last_drill_at is null or b.last_drill_at <= now() - interval '92 days'
                   )
              from iam.break_glass_account b
             where b.user_id = private.uid()),
           '{}'::jsonb);
$$;
