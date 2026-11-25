-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION document_version_promote(
    p_version_id uuid,
    p_storage_path text
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
    if v_role <> 'int_sysadmin' then
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
  end if;

  update core.document_version
     set storage_path = p_storage_path
   where id = p_version_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO ext_user;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_auditor;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_compliance;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_finance;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_hr;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_manager;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_surveyor;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION document_version_promote(p_version_id uuid, p_storage_path text) TO int_viewer;
