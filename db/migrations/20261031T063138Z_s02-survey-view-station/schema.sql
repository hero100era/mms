-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION org_unit_name(
    p_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select name from core.org_unit where id = p_id;
$$;

REVOKE EXECUTE ON FUNCTION org_unit_name(p_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO ext_user;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_unit_name(p_id uuid) TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE VIEW survey_requests WITH (security_invoker=true) AS
 SELECT r.id,
    r.request_no,
    r.ship_id,
    s.name AS ship_name,
    s.imo_number AS ship_imo_number,
    r.org_id,
    o.name AS org_name,
    r.office_unit_id,
    private.org_unit_name(r.office_unit_id) AS station_name,
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
     JOIN party.organization o ON o.id = r.org_id;
