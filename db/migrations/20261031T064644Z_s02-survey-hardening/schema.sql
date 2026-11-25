-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION can_read_document(
    p_document_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select exists (
    select 1
    from core.document d
    where d.id = p_document_id
      and (
        case
          when d.entity_type = 'survey_request' then
            case
              when private.active_role() = 'ext_user' then
                exists (
                  select 1 from survey.survey_request r
                  where r.id = d.entity_id
                    and r.org_id = any (private.my_org_ids())
                )
              else
                exists (
                  select 1 from survey.survey_request r
                  where r.id = d.entity_id
                    and r.office_unit_id = any (private.my_offices())
                )
            end
          else false
        end
      )
  );
$$;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

ALTER POLICY document_staff_read ON document USING (private.can_read_document(id));

ALTER POLICY document_version_staff_read ON document_version USING (private.can_read_document(document_id));

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

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

  select id into v_doc_id from core.document
   where entity_type = p_entity_type and entity_id = p_entity_id and doc_type = p_doc_type
   limit 1;

  if v_doc_id is null then
    insert into core.document (entity_type, entity_id, doc_type, title, created_by)
    values (p_entity_type, p_entity_id, p_doc_type, p_title, private.uid())
    returning id into v_doc_id;
  end if;

  select coalesce(max(revision_no), 0) + 1 into v_rev
    from core.document_version
   where document_id = v_doc_id;

  insert into core.document_version (
    document_id, revision_no, storage_path, file_name, mime_type, byte_size, sha256, created_by
  ) values (
    v_doc_id, v_rev, p_storage_path, p_file_name, p_mime_type, p_byte_size, p_sha256, private.uid()
  ) returning id into v_version_id;

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

CREATE OR REPLACE FUNCTION survey_request_create(
    p_ship_id uuid,
    p_org_id uuid,
    p_office_unit_id uuid,
    p_port_name text,
    p_port_country text DEFAULT 'CN',
    p_port_code text DEFAULT NULL,
    p_estimated_arrival timestamptz DEFAULT (now() + '7 days'::interval),
    p_estimated_departure timestamptz DEFAULT (now() + '10 days'::interval),
    p_survey_types text[] DEFAULT '{}',
    p_scope_description text DEFAULT NULL,
    p_agent_contact jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION survey_request_submit(
    p_id uuid,
    p_reason text DEFAULT 'Submitted for station triage'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_role text := private.active_role();
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
   where id = p_id;

  perform private.emit_event(
    'survey.request.submitted', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'submitted')
  );

  return p_id;
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_transfer(
    p_id uuid,
    p_new_office_unit_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_target_type text;
  v_previous_office uuid;
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
   where id = p_id;

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
