
create view api.ships
with (security_invoker = true)
as
select
  s.id,
  s.imo_number,
  s.name,
  s.ship_type,
  s.flag_code,
  s.gross_tonnage,
  s.build_year,
  s.status,
  s.responsible_mts_unit_id,
  s.created_at,
  s.updated_at
from fleet.ship s;

create view api.survey_requests
with (security_invoker = true)
as
select
  r.id,
  r.request_no,
  r.ship_id,
  s.name as ship_name,
  s.imo_number as ship_imo_number,
  r.org_id,
  o.name as org_name,
  r.office_unit_id,
  private.org_unit_name(r.office_unit_id) as station_name,
  r.status,
  r.survey_types,
  r.port_name,
  r.port_country,
  r.port_code,
  r.estimated_arrival,
  r.estimated_departure,
  r.agent_contact,
  r.scope_description,
  r.triage_notes,
  r.created_at,
  r.created_by,
  r.updated_at,
  r.updated_by
from survey.survey_request r
join fleet.ship s on s.id = r.ship_id
join party.organization o on o.id = r.org_id;

create view api.documents
with (security_invoker = true)
as
select
  d.id,
  d.entity_type,
  d.entity_id,
  d.doc_type,
  d.title,
  d.status,
  d.created_at,
  d.updated_at
from core.document d;

create view api.document_versions
with (security_invoker = true)
as
select
  v.id,
  v.document_id,
  v.revision_no,
  v.file_name,
  v.mime_type,
  v.byte_size,
  encode(v.sha256, 'hex') as sha256,
  v.storage_path,
  v.scan_status,
  v.scanned_at,
  v.threat_name,
  v.scanner_engine,
  v.created_at,
  v.created_by
from core.document_version v;

grant select on api.ships to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on api.survey_requests to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on api.documents to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on api.document_versions to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin, worker;

create function api.survey_request_create(
  p_ship_id uuid,
  p_org_id uuid,
  p_office_unit_id uuid,
  p_port_name text,
  p_port_country text default 'CN',
  p_port_code text default null,
  p_estimated_arrival timestamptz default (now() + interval '7 days'),
  p_estimated_departure timestamptz default (now() + interval '10 days'),
  p_survey_types text[] default '{}'::text[],
  p_scope_description text default null,
  p_agent_contact jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_request_no text;
  v_role text := private.active_role();
  v_station_type text;
begin
  select unit_type into v_station_type from core.org_unit where id = p_office_unit_id and active;
  if v_station_type is distinct from 'station' then
    raise exception 'office_unit_id must reference an active station' using errcode = '23514';
  end if;

  if v_role = 'ext_user' then
    if not (p_org_id = any (private.my_org_ids())) then
      raise exception 'unauthorized_org' using errcode = '42501';
    end if;
    if not exists (
      select 1 from fleet.ship_party
       where ship_id = p_ship_id
         and org_id = p_org_id
         and valid @> now()
    ) then
      raise exception 'unauthorized_ship_party' using errcode = '42501';
    end if;
  elsif v_role in ('int_coordinator', 'int_manager', 'int_sysadmin') then
    if not exists (select 1 from party.organization where id = p_org_id and status = 'active') then
      raise exception 'organization_not_found' using errcode = '22023';
    end if;
    if not exists (select 1 from fleet.ship where id = p_ship_id) then
      raise exception 'ship_not_found' using errcode = '22023';
    end if;
    if v_role <> 'int_sysadmin' then
      perform private.assert_in_scope(p_office_unit_id);
    end if;
  else
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_port_name is null or btrim(p_port_name) = '' then
    raise exception 'port_name_required' using errcode = '22023';
  end if;

  if p_estimated_departure < p_estimated_arrival then
    raise exception 'invalid_dates: departure must be >= arrival' using errcode = '22023';
  end if;

  v_request_no := 'SR-' || to_char(clock_timestamp(), 'YYYYMM') || '-' || lpad((nextval('survey.request_no_seq'))::text, 5, '0');

  insert into survey.survey_request (
    request_no, ship_id, org_id, office_unit_id, status,
    survey_types, port_name, port_country, port_code,
    estimated_arrival, estimated_departure, agent_contact, scope_description,
    created_by
  ) values (
    v_request_no, p_ship_id, p_org_id, p_office_unit_id, 'draft',
    p_survey_types, p_port_name, p_port_country, p_port_code,
    p_estimated_arrival, p_estimated_departure, p_agent_contact, p_scope_description,
    private.uid()
  ) returning id into v_id;

  perform private.emit_event(
    'survey.request.created', 'success', 'survey_request', v_id, p_office_unit_id, null,
    jsonb_build_object('request_no', v_request_no, 'ship_id', p_ship_id, 'org_id', p_org_id)
  );

  return v_id;
end;
$$;

create function api.survey_request_submit(
  p_id uuid,
  p_reason text default 'Submitted for station triage'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req survey.survey_request;
  v_role text := private.active_role();
  v_changed int;
begin
  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_role = 'ext_user' then
    if not (v_req.org_id = any (private.my_org_ids())) then
      raise exception 'unauthorized_org' using errcode = '42501';
    end if;
  elsif v_role in ('int_coordinator', 'int_manager', 'int_sysadmin') then
    if v_role <> 'int_sysadmin' then
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
  else
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Idempotent submit
  if v_req.status = 'submitted' then
    return p_id;
  end if;

  if v_req.status not in ('draft', 'clarification_requested') then
    raise exception 'invalid_state_transition: cannot submit from %', v_req.status using errcode = '22023';
  end if;

  if v_req.survey_types is null or cardinality(v_req.survey_types) = 0 then
    raise exception 'survey_types_required' using errcode = '22023';
  end if;

  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'submitted',
         updated_by = private.uid()
   where id = p_id
     and status in ('draft', 'clarification_requested');
  -- R2.4: the state predicate and the row count make the transition atomic
  -- even if the row changed between the lock and the UPDATE. `id` is the PK,
  -- so anything other than exactly one row is a conflict, not a silent no-op.
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.submitted', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'submitted')
  );

  return p_id;
end;
$$;

create function api.survey_request_accept(
  p_id uuid,
  p_reason text,
  p_triage_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req survey.survey_request;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: must be submitted' using errcode = '22023';
  end if;

  -- R6.3: Segregation of Duties (Four-Eyes Review): Creator cannot accept their own survey request
  if v_req.created_by is not null and v_req.created_by = private.uid() then
    raise exception 'creator_cannot_approve' using errcode = '42501';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'accepted',
         triage_notes = coalesce(p_triage_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.accepted', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'accepted', 'triage_notes', p_triage_notes)
  );
end;
$$;

create function api.survey_request_request_clarification(
  p_id uuid,
  p_reason text,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req survey.survey_request;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: must be submitted' using errcode = '22023';
  end if;

  -- R6.3: Segregation of Duties (Four-Eyes Review): Creator cannot accept their own survey request
  if v_req.created_by is not null and v_req.created_by = private.uid() then
    raise exception 'creator_cannot_approve' using errcode = '42501';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'clarification_requested',
         triage_notes = coalesce(p_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.clarification_requested', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'clarification_requested', 'triage_notes', p_notes)
  );
end;
$$;

create function api.survey_request_reject(
  p_id uuid,
  p_reason text,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req survey.survey_request;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: must be submitted' using errcode = '22023';
  end if;

  -- R6.3: Segregation of Duties (Four-Eyes Review): Creator cannot accept their own survey request
  if v_req.created_by is not null and v_req.created_by = private.uid() then
    raise exception 'creator_cannot_approve' using errcode = '42501';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'rejected',
         triage_notes = coalesce(p_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.rejected', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'rejected', 'triage_notes', p_notes)
  );
end;
$$;

create function api.survey_request_transfer(
  p_id uuid,
  p_new_office_unit_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req survey.survey_request;
  v_target_type text;
  v_previous_office uuid;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: only submitted requests can be transferred' using errcode = '22023';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');

  select unit_type into v_target_type from core.org_unit where id = p_new_office_unit_id and active;
  if v_target_type is distinct from 'station' then
    raise exception 'target unit must be an active station' using errcode = '23514';
  end if;

  if p_new_office_unit_id = v_req.office_unit_id then
    return;
  end if;

  v_previous_office := v_req.office_unit_id;
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set office_unit_id = p_new_office_unit_id,
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.transferred', 'success', 'survey_request', p_id, p_new_office_unit_id, p_reason,
    jsonb_build_object(
      'request_no', v_req.request_no,
      'previous_office_unit_id', v_previous_office,
      'new_office_unit_id', p_new_office_unit_id
    )
  );
end;
$$;

create function api.document_create_version(
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
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
  -- ADR-0023 §3: "clean" is not a property of a path.
  --
  -- A version starts `pending` and no upload row is attached. The only thing
  -- that can turn it `clean` is private.document_version_record_scan, called by
  -- the worker after the approved scanner returns a verdict, which also stamps
  -- scanned_at and links the core.upload row it verified. A caller that writes a
  -- non-quarantine path therefore gets an unscanned version, not a clean one.
  begin
    insert into core.document_version (
      document_id, revision_no, storage_path, file_name, mime_type, byte_size, sha256,
      scan_status, scanned_at, created_by
    ) values (
      v_doc_id, v_rev, p_storage_path, p_file_name, p_mime_type, p_byte_size, p_sha256,
      'pending', null,
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

create function api.document_version_promote(
  p_version_id uuid,
  p_storage_path text
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
  v_role text := private.active_role();
begin
  if v_role in ('ext_user', 'int_viewer', 'int_compliance') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_version from core.document_version where id = p_version_id;
  if not found then
    raise exception 'version_not_found' using errcode = '22023';
  end if;

  if not (v_version.storage_path like 'quarantine/%') then
    raise exception 'already_promoted' using errcode = '22023';
  end if;

  if p_storage_path is null or p_storage_path like 'quarantine/%' then
    raise exception 'invalid_promoted_path' using errcode = '22023';
  end if;

  select * into v_doc from core.document where id = v_version.document_id;
  if not found then
    raise exception 'document_not_found' using errcode = '22023';
  end if;

  if v_doc.entity_type = 'survey_request' then
    select * into v_req from survey.survey_request where id = v_doc.entity_id;
    if not found then
      raise exception 'survey_request_not_found' using errcode = '22023';
    end if;
    if v_role not in ('int_sysadmin', 'worker') then
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
  end if;

  -- ADR-0023 §8: promotion moves a file out of quarantine for download. It must
  -- therefore require a *recorded clean verdict*, not merely "not infected".
  -- A pending version has never been scanned; allowing it through is the hole
  -- this ADR closes.
  if v_version.scan_status = 'infected' then
    raise exception 'infected_document_cannot_be_promoted' using errcode = '42501';
  end if;
  if v_version.scan_status <> 'clean' or v_version.scanned_at is null then
    raise exception 'unscanned_document_cannot_be_promoted' using errcode = '42501';
  end if;

  update core.document_version
     set storage_path = p_storage_path,
         scan_status = 'clean',
         scanned_at = coalesce(scanned_at, clock_timestamp())
   where id = p_version_id;
end;
$$;

create function api.document_version_record_scan(
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
begin
  perform private.document_version_record_scan(
    p_version_id, p_status, p_scanner_engine, p_threat_name, p_promoted_path, p_detail
  );
end;
$$;

revoke all on function api.survey_request_create(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text[], text, jsonb) from public;
revoke all on function api.survey_request_submit(uuid, text) from public;
revoke all on function api.survey_request_accept(uuid, text, text) from public;
revoke all on function api.survey_request_request_clarification(uuid, text, text) from public;
revoke all on function api.survey_request_reject(uuid, text, text) from public;
revoke all on function api.survey_request_transfer(uuid, uuid, text) from public;
revoke all on function api.document_create_version(text, uuid, text, text, text, text, bigint, bytea, text) from public;
revoke all on function api.document_version_promote(uuid, text) from public;
revoke all on function api.document_version_record_scan(uuid, text, text, text, text, jsonb) from public;

grant execute on function api.survey_request_create(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text[], text, jsonb) to
  ext_user, int_coordinator, int_manager, int_sysadmin;
grant execute on function api.survey_request_submit(uuid, text) to
  ext_user, int_coordinator, int_manager, int_sysadmin;
grant execute on function api.survey_request_accept(uuid, text, text) to
  int_viewer, int_coordinator, int_manager, int_compliance;
grant execute on function api.survey_request_request_clarification(uuid, text, text) to
  int_viewer, int_coordinator, int_manager, int_compliance;
grant execute on function api.survey_request_reject(uuid, text, text) to
  int_viewer, int_coordinator, int_manager, int_compliance;
grant execute on function api.survey_request_transfer(uuid, uuid, text) to
  int_viewer, int_coordinator, int_manager, int_compliance;
-- R1.2: int_viewer and int_compliance are always rejected by
-- document_create_version's body (insufficient_privilege before any work), so
-- they must not hold EXECUTE. ext_user is granted deliberately: it passes the
-- org-membership check for its own organisation. int_auditor, int_hr and
-- int_finance have no explicit rejection, so they keep the grant and are
-- constrained by private.assert_in_scope instead.
grant execute on function api.document_create_version(text, uuid, text, text, text, text, bigint, bytea, text) to
  ext_user, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_hr, int_finance, int_sysadmin;
-- R1.2: ext_user, int_viewer and int_compliance are always rejected inside
-- the function body, so they must not hold EXECUTE at all. int_coordinator and
-- int_manager are likewise always rejected by private.document_version_record_scan.
grant execute on function api.document_version_promote(uuid, text) to
  int_surveyor, int_auditor, int_coordinator, int_manager,
  int_hr, int_finance, int_sysadmin, worker;
grant execute on function api.document_version_record_scan(uuid, text, text, text, text, jsonb) to
  int_sysadmin, worker;





