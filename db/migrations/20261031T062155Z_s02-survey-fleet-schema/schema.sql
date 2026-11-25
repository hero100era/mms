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
  select case
    when private.active_role() <> 'ext_user' then true
    else exists (
      select 1
      from core.document d
      join survey.survey_request r on r.id = d.entity_id and d.entity_type = 'survey_request'
      where d.id = p_document_id
        and r.org_id = any (private.my_org_ids())
    )
  end;
$$;

CREATE OR REPLACE FUNCTION survey_request_office_check()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_type text;
begin
  select unit_type into v_type from core.org_unit where id = new.office_unit_id and active;
  if v_type is distinct from 'station' then
    raise exception 'office_unit_id must reference an active station' using errcode = '23514';
  end if;
  return new;
end;
$$;

REVOKE EXECUTE ON FUNCTION can_read_document(p_document_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_office_check() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO ext_user;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION can_read_document(p_document_id uuid) TO int_viewer;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE TABLE IF NOT EXISTS document (
    id uuid DEFAULT uuidv7(),
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    doc_type text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT document_pk PRIMARY KEY (id),
    CONSTRAINT document_status_ck CHECK (status IN ('active'::text, 'archived'::text, 'superseded'::text))
);

CREATE INDEX IF NOT EXISTS document_entity_ix ON document (entity_type, entity_id);

ALTER TABLE document ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_ext_read ON document FOR SELECT TO ext_user USING (private.can_read_document(id));

CREATE POLICY document_staff_read ON document FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS document_version (
    id uuid DEFAULT uuidv7(),
    document_id uuid NOT NULL,
    revision_no integer DEFAULT 1 NOT NULL,
    storage_path text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 bytea NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT document_version_pk PRIMARY KEY (id),
    CONSTRAINT document_version_revision_uk UNIQUE (document_id, revision_no),
    CONSTRAINT document_version_document_fk FOREIGN KEY (document_id) REFERENCES document (id),
    CONSTRAINT document_version_byte_size_ck CHECK (byte_size >= 0),
    CONSTRAINT document_version_revision_ck CHECK (revision_no >= 1),
    CONSTRAINT document_version_sha256_ck CHECK (octet_length(sha256) = 32)
);

CREATE INDEX IF NOT EXISTS document_version_document_ix ON document_version (document_id);

ALTER TABLE document_version ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_version_staff_read ON document_version FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE POLICY document_version_ext_read ON document_version FOR SELECT TO ext_user USING (private.can_read_document(document_id));

CREATE OR REPLACE TRIGGER document_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON document
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER document_stamp
    BEFORE INSERT OR UPDATE ON document
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER document_version_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON document_version
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

GRANT SELECT ON TABLE document TO ext_user;

GRANT SELECT ON TABLE document TO int_auditor;

GRANT SELECT ON TABLE document TO int_compliance;

GRANT SELECT ON TABLE document TO int_coordinator;

GRANT SELECT ON TABLE document TO int_finance;

GRANT SELECT ON TABLE document TO int_hr;

GRANT SELECT ON TABLE document TO int_manager;

GRANT SELECT ON TABLE document TO int_surveyor;

GRANT SELECT ON TABLE document TO int_sysadmin;

GRANT SELECT ON TABLE document TO int_viewer;

GRANT SELECT ON TABLE document_version TO ext_user;

GRANT SELECT ON TABLE document_version TO int_auditor;

GRANT SELECT ON TABLE document_version TO int_compliance;

GRANT SELECT ON TABLE document_version TO int_coordinator;

GRANT SELECT ON TABLE document_version TO int_finance;

GRANT SELECT ON TABLE document_version TO int_hr;

GRANT SELECT ON TABLE document_version TO int_manager;

GRANT SELECT ON TABLE document_version TO int_surveyor;

GRANT SELECT ON TABLE document_version TO int_sysadmin;

GRANT SELECT ON TABLE document_version TO int_viewer;

-- ===== schema: fleet  (pgschema 1.13.4) =====

set local search_path = fleet;

CREATE TABLE IF NOT EXISTS ship (
    id uuid DEFAULT uuidv7(),
    imo_number text NOT NULL,
    name text NOT NULL,
    ship_type text DEFAULT 'bulk_carrier' NOT NULL,
    flag_state text DEFAULT 'PA' NOT NULL,
    gross_tonnage integer,
    build_year integer,
    status text DEFAULT 'in_service' NOT NULL,
    responsible_mts_unit_id uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ship_pk PRIMARY KEY (id),
    CONSTRAINT ship_imo_number_uk UNIQUE (imo_number),
    CONSTRAINT ship_build_year_ck CHECK (build_year IS NULL OR build_year >= 1900 AND build_year <= 2100),
    CONSTRAINT ship_gross_tonnage_ck CHECK (gross_tonnage IS NULL OR gross_tonnage > 0),
    CONSTRAINT ship_imo_number_ck CHECK (imo_number ~ '^[0-9]{7}$'::text),
    CONSTRAINT ship_status_ck CHECK (status IN ('in_service'::text, 'laid_up'::text, 'under_construction'::text, 'decommissioned'::text))
);

CREATE INDEX IF NOT EXISTS ship_responsible_mts_ix ON ship (responsible_mts_unit_id);

ALTER TABLE ship ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_staff_read ON ship FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS ship_party (
    id uuid DEFAULT uuidv7(),
    ship_id uuid NOT NULL,
    org_id uuid NOT NULL,
    party_role text NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ship_party_pk PRIMARY KEY (id),
    CONSTRAINT ship_party_ship_fk FOREIGN KEY (ship_id) REFERENCES ship (id),
    CONSTRAINT ship_party_role_ck CHECK (party_role IN ('owner'::text, 'manager'::text, 'doc_holder'::text, 'builder'::text, 'agent'::text)),
    CONSTRAINT ship_party_ex EXCLUDE USING gist (ship_id WITH =, org_id WITH =, party_role WITH =, valid WITH &&)
);

CREATE INDEX IF NOT EXISTS ship_party_org_ix ON ship_party (org_id);

CREATE INDEX IF NOT EXISTS ship_party_ship_ix ON ship_party (ship_id);

ALTER TABLE ship_party ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_party_ext_read ON ship_party FOR SELECT TO ext_user USING (org_id = ANY (private.my_org_ids()));

CREATE POLICY ship_party_staff_read ON ship_party FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE ship
ADD CONSTRAINT ship_responsible_mts_fk FOREIGN KEY (responsible_mts_unit_id) REFERENCES core.org_unit (id);

ALTER TABLE ship_party
ADD CONSTRAINT ship_party_org_fk FOREIGN KEY (org_id) REFERENCES party.organization (id);

CREATE POLICY ship_ext_read ON ship FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = ship.id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))));

CREATE OR REPLACE TRIGGER ship_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON ship
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER ship_party_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON ship_party
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER ship_party_stamp
    BEFORE INSERT OR UPDATE ON ship_party
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER ship_stamp
    BEFORE INSERT OR UPDATE ON ship
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

GRANT SELECT ON TABLE ship TO ext_user;

GRANT SELECT ON TABLE ship TO int_auditor;

GRANT SELECT ON TABLE ship TO int_compliance;

GRANT SELECT ON TABLE ship TO int_coordinator;

GRANT SELECT ON TABLE ship TO int_finance;

GRANT SELECT ON TABLE ship TO int_hr;

GRANT SELECT ON TABLE ship TO int_manager;

GRANT SELECT ON TABLE ship TO int_surveyor;

GRANT SELECT ON TABLE ship TO int_sysadmin;

GRANT SELECT ON TABLE ship TO int_viewer;

GRANT SELECT ON TABLE ship_party TO ext_user;

GRANT SELECT ON TABLE ship_party TO int_auditor;

GRANT SELECT ON TABLE ship_party TO int_compliance;

GRANT SELECT ON TABLE ship_party TO int_coordinator;

GRANT SELECT ON TABLE ship_party TO int_finance;

GRANT SELECT ON TABLE ship_party TO int_hr;

GRANT SELECT ON TABLE ship_party TO int_manager;

GRANT SELECT ON TABLE ship_party TO int_surveyor;

GRANT SELECT ON TABLE ship_party TO int_sysadmin;

GRANT SELECT ON TABLE ship_party TO int_viewer;

-- ===== schema: survey  (pgschema 1.13.4) =====

set local search_path = survey;

CREATE SEQUENCE IF NOT EXISTS request_no_seq START WITH 1000;

CREATE TABLE IF NOT EXISTS survey_request (
    id uuid DEFAULT uuidv7(),
    request_no text NOT NULL,
    ship_id uuid NOT NULL,
    org_id uuid NOT NULL,
    office_unit_id uuid NOT NULL,
    status text DEFAULT 'draft' NOT NULL,
    survey_types text[] DEFAULT '{}' NOT NULL,
    port_name text NOT NULL,
    port_country text DEFAULT 'CN' NOT NULL,
    port_code text,
    estimated_arrival timestamptz DEFAULT now() NOT NULL,
    estimated_departure timestamptz DEFAULT (now() + '3 days'::interval) NOT NULL,
    agent_contact jsonb DEFAULT '{}' NOT NULL,
    scope_description text,
    triage_notes text,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT survey_request_pk PRIMARY KEY (id),
    CONSTRAINT survey_request_request_no_uk UNIQUE (request_no),
    CONSTRAINT survey_request_dates_ck CHECK (estimated_departure >= estimated_arrival),
    CONSTRAINT survey_request_status_ck CHECK (status IN ('draft'::text, 'submitted'::text, 'accepted'::text, 'clarification_requested'::text, 'rejected'::text))
);

CREATE INDEX IF NOT EXISTS survey_request_office_ix ON survey_request (office_unit_id);

CREATE INDEX IF NOT EXISTS survey_request_org_ix ON survey_request (org_id);

CREATE INDEX IF NOT EXISTS survey_request_ship_ix ON survey_request (ship_id);

CREATE INDEX IF NOT EXISTS survey_request_status_ix ON survey_request (status);

ALTER TABLE survey_request ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_request_ext_read ON survey_request FOR SELECT TO ext_user USING (org_id = ANY (private.my_org_ids()));

CREATE POLICY survey_request_staff_read ON survey_request FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (office_unit_id = ANY (private.my_offices()));

ALTER TABLE survey_request
ADD CONSTRAINT survey_request_office_fk FOREIGN KEY (office_unit_id) REFERENCES core.org_unit (id);

ALTER TABLE survey_request
ADD CONSTRAINT survey_request_org_fk FOREIGN KEY (org_id) REFERENCES party.organization (id);

ALTER TABLE survey_request
ADD CONSTRAINT survey_request_ship_fk FOREIGN KEY (ship_id) REFERENCES fleet.ship (id);

CREATE OR REPLACE TRIGGER survey_request_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON survey_request
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER survey_request_office_check
    BEFORE INSERT OR UPDATE ON survey_request
    FOR EACH ROW
    EXECUTE FUNCTION private.survey_request_office_check();

CREATE OR REPLACE TRIGGER survey_request_stamp
    BEFORE INSERT OR UPDATE ON survey_request
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

GRANT USAGE ON SEQUENCE request_no_seq TO ext_user;

GRANT USAGE ON SEQUENCE request_no_seq TO int_coordinator;

GRANT USAGE ON SEQUENCE request_no_seq TO int_manager;

GRANT USAGE ON SEQUENCE request_no_seq TO int_sysadmin;

GRANT SELECT ON TABLE survey_request TO ext_user;

GRANT SELECT ON TABLE survey_request TO int_auditor;

GRANT SELECT ON TABLE survey_request TO int_compliance;

GRANT SELECT ON TABLE survey_request TO int_coordinator;

GRANT SELECT ON TABLE survey_request TO int_finance;

GRANT SELECT ON TABLE survey_request TO int_hr;

GRANT SELECT ON TABLE survey_request TO int_manager;

GRANT SELECT ON TABLE survey_request TO int_surveyor;

GRANT SELECT ON TABLE survey_request TO int_sysadmin;

GRANT SELECT ON TABLE survey_request TO int_viewer;

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
    if v_role = 'ext_user' and not (v_req.org_id = any (private.my_org_ids())) then
      raise exception 'unauthorized' using errcode = '42501';
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

CREATE OR REPLACE FUNCTION survey_request_accept(
    p_id uuid,
    p_reason text,
    p_triage_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
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

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'accepted',
         triage_notes = coalesce(p_triage_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id;

  perform private.emit_event(
    'survey.request.accepted', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'accepted', 'triage_notes', p_triage_notes)
  );
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

CREATE OR REPLACE FUNCTION survey_request_reject(
    p_id uuid,
    p_reason text,
    p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
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

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'rejected',
         triage_notes = coalesce(p_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id;

  perform private.emit_event(
    'survey.request.rejected', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'rejected', 'triage_notes', p_notes)
  );
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_request_clarification(
    p_id uuid,
    p_reason text,
    p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
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

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'clarification_requested',
         triage_notes = coalesce(p_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id;

  perform private.emit_event(
    'survey.request.clarification_requested', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'clarification_requested', 'triage_notes', p_notes)
  );
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
  end if;

  -- Idempotent submit
  if v_req.status = 'submitted' then
    return p_id;
  end if;

  if v_req.status not in ('draft', 'clarification_requested') then
    raise exception 'invalid_state_transition: cannot submit from %', v_req.status using errcode = '22023';
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

CREATE OR REPLACE VIEW document_versions WITH (security_invoker=true) AS
 SELECT id,
    document_id,
    revision_no,
    file_name,
    mime_type,
    byte_size,
    encode(sha256, 'hex'::text) AS sha256,
    storage_path,
    created_at,
    created_by
   FROM core.document_version v;

CREATE OR REPLACE VIEW documents WITH (security_invoker=true) AS
 SELECT id,
    entity_type,
    entity_id,
    doc_type,
    title,
    status,
    created_at,
    updated_at
   FROM core.document d;

CREATE OR REPLACE VIEW ships WITH (security_invoker=true) AS
 SELECT id,
    imo_number,
    name,
    ship_type,
    flag_state,
    gross_tonnage,
    build_year,
    status,
    responsible_mts_unit_id,
    created_at,
    updated_at
   FROM fleet.ship s;

CREATE OR REPLACE VIEW survey_requests WITH (security_invoker=true) AS
 SELECT r.id,
    r.request_no,
    r.ship_id,
    s.name AS ship_name,
    s.imo_number AS ship_imo_number,
    r.org_id,
    o.name AS org_name,
    r.office_unit_id,
    u.name AS station_name,
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
   FROM survey.survey_request r
     JOIN fleet.ship s ON s.id = r.ship_id
     JOIN party.organization o ON o.id = r.org_id
     JOIN core.org_unit u ON u.id = r.office_unit_id;

REVOKE EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_accept(p_id uuid, p_reason text, p_triage_notes text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_create(p_ship_id uuid, p_org_id uuid, p_office_unit_id uuid, p_port_name text, p_port_country text, p_port_code text, p_estimated_arrival timestamp with time zone, p_estimated_departure timestamp with time zone, p_survey_types text[], p_scope_description text, p_agent_contact jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_reject(p_id uuid, p_reason text, p_notes text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_request_clarification(p_id uuid, p_reason text, p_notes text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_submit(p_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION survey_request_transfer(p_id uuid, p_new_office_unit_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO ext_user;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_auditor;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_compliance;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_finance;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_hr;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_manager;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_surveyor;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) TO int_viewer;

GRANT EXECUTE ON FUNCTION survey_request_accept(p_id uuid, p_reason text, p_triage_notes text) TO int_compliance;

GRANT EXECUTE ON FUNCTION survey_request_accept(p_id uuid, p_reason text, p_triage_notes text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION survey_request_accept(p_id uuid, p_reason text, p_triage_notes text) TO int_manager;

GRANT EXECUTE ON FUNCTION survey_request_accept(p_id uuid, p_reason text, p_triage_notes text) TO int_viewer;

GRANT EXECUTE ON FUNCTION survey_request_create(p_ship_id uuid, p_org_id uuid, p_office_unit_id uuid, p_port_name text, p_port_country text, p_port_code text, p_estimated_arrival timestamp with time zone, p_estimated_departure timestamp with time zone, p_survey_types text[], p_scope_description text, p_agent_contact jsonb) TO ext_user;

GRANT EXECUTE ON FUNCTION survey_request_create(p_ship_id uuid, p_org_id uuid, p_office_unit_id uuid, p_port_name text, p_port_country text, p_port_code text, p_estimated_arrival timestamp with time zone, p_estimated_departure timestamp with time zone, p_survey_types text[], p_scope_description text, p_agent_contact jsonb) TO int_coordinator;

GRANT EXECUTE ON FUNCTION survey_request_create(p_ship_id uuid, p_org_id uuid, p_office_unit_id uuid, p_port_name text, p_port_country text, p_port_code text, p_estimated_arrival timestamp with time zone, p_estimated_departure timestamp with time zone, p_survey_types text[], p_scope_description text, p_agent_contact jsonb) TO int_manager;

GRANT EXECUTE ON FUNCTION survey_request_create(p_ship_id uuid, p_org_id uuid, p_office_unit_id uuid, p_port_name text, p_port_country text, p_port_code text, p_estimated_arrival timestamp with time zone, p_estimated_departure timestamp with time zone, p_survey_types text[], p_scope_description text, p_agent_contact jsonb) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION survey_request_reject(p_id uuid, p_reason text, p_notes text) TO int_compliance;

GRANT EXECUTE ON FUNCTION survey_request_reject(p_id uuid, p_reason text, p_notes text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION survey_request_reject(p_id uuid, p_reason text, p_notes text) TO int_manager;

GRANT EXECUTE ON FUNCTION survey_request_reject(p_id uuid, p_reason text, p_notes text) TO int_viewer;

GRANT EXECUTE ON FUNCTION survey_request_request_clarification(p_id uuid, p_reason text, p_notes text) TO int_compliance;

GRANT EXECUTE ON FUNCTION survey_request_request_clarification(p_id uuid, p_reason text, p_notes text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION survey_request_request_clarification(p_id uuid, p_reason text, p_notes text) TO int_manager;

GRANT EXECUTE ON FUNCTION survey_request_request_clarification(p_id uuid, p_reason text, p_notes text) TO int_viewer;

GRANT EXECUTE ON FUNCTION survey_request_submit(p_id uuid, p_reason text) TO ext_user;

GRANT EXECUTE ON FUNCTION survey_request_submit(p_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION survey_request_submit(p_id uuid, p_reason text) TO int_manager;

GRANT EXECUTE ON FUNCTION survey_request_submit(p_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION survey_request_transfer(p_id uuid, p_new_office_unit_id uuid, p_reason text) TO int_compliance;

GRANT EXECUTE ON FUNCTION survey_request_transfer(p_id uuid, p_new_office_unit_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION survey_request_transfer(p_id uuid, p_new_office_unit_id uuid, p_reason text) TO int_manager;

GRANT EXECUTE ON FUNCTION survey_request_transfer(p_id uuid, p_new_office_unit_id uuid, p_reason text) TO int_viewer;

GRANT SELECT ON TABLE document_versions TO ext_user;

GRANT SELECT ON TABLE document_versions TO int_auditor;

GRANT SELECT ON TABLE document_versions TO int_compliance;

GRANT SELECT ON TABLE document_versions TO int_coordinator;

GRANT SELECT ON TABLE document_versions TO int_finance;

GRANT SELECT ON TABLE document_versions TO int_hr;

GRANT SELECT ON TABLE document_versions TO int_manager;

GRANT SELECT ON TABLE document_versions TO int_surveyor;

GRANT SELECT ON TABLE document_versions TO int_sysadmin;

GRANT SELECT ON TABLE document_versions TO int_viewer;

GRANT SELECT ON TABLE documents TO ext_user;

GRANT SELECT ON TABLE documents TO int_auditor;

GRANT SELECT ON TABLE documents TO int_compliance;

GRANT SELECT ON TABLE documents TO int_coordinator;

GRANT SELECT ON TABLE documents TO int_finance;

GRANT SELECT ON TABLE documents TO int_hr;

GRANT SELECT ON TABLE documents TO int_manager;

GRANT SELECT ON TABLE documents TO int_surveyor;

GRANT SELECT ON TABLE documents TO int_sysadmin;

GRANT SELECT ON TABLE documents TO int_viewer;

GRANT SELECT ON TABLE ships TO ext_user;

GRANT SELECT ON TABLE ships TO int_auditor;

GRANT SELECT ON TABLE ships TO int_compliance;

GRANT SELECT ON TABLE ships TO int_coordinator;

GRANT SELECT ON TABLE ships TO int_finance;

GRANT SELECT ON TABLE ships TO int_hr;

GRANT SELECT ON TABLE ships TO int_manager;

GRANT SELECT ON TABLE ships TO int_surveyor;

GRANT SELECT ON TABLE ships TO int_sysadmin;

GRANT SELECT ON TABLE ships TO int_viewer;

GRANT SELECT ON TABLE survey_requests TO ext_user;

GRANT SELECT ON TABLE survey_requests TO int_auditor;

GRANT SELECT ON TABLE survey_requests TO int_compliance;

GRANT SELECT ON TABLE survey_requests TO int_coordinator;

GRANT SELECT ON TABLE survey_requests TO int_finance;

GRANT SELECT ON TABLE survey_requests TO int_hr;

GRANT SELECT ON TABLE survey_requests TO int_manager;

GRANT SELECT ON TABLE survey_requests TO int_surveyor;

GRANT SELECT ON TABLE survey_requests TO int_sysadmin;

GRANT SELECT ON TABLE survey_requests TO int_viewer;
