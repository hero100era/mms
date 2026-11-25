-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

REVOKE EXECUTE ON FUNCTION emit_event(p_event_type text, p_outcome text, p_subject_type text, p_subject_id uuid, p_scope_unit_id uuid, p_reason text, p_detail jsonb) FROM int_compliance;

REVOKE EXECUTE ON FUNCTION emit_event(p_event_type text, p_outcome text, p_subject_type text, p_subject_id uuid, p_scope_unit_id uuid, p_reason text, p_detail jsonb) FROM int_sysadmin;
