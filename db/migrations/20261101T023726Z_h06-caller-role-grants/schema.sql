-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

REVOKE EXECUTE ON FUNCTION caller_role() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION is_worker() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION caller_role() TO ext_user;

GRANT EXECUTE ON FUNCTION caller_role() TO int_auditor;

GRANT EXECUTE ON FUNCTION caller_role() TO int_compliance;

GRANT EXECUTE ON FUNCTION caller_role() TO int_coordinator;

GRANT EXECUTE ON FUNCTION caller_role() TO int_finance;

GRANT EXECUTE ON FUNCTION caller_role() TO int_hr;

GRANT EXECUTE ON FUNCTION caller_role() TO int_manager;

GRANT EXECUTE ON FUNCTION caller_role() TO int_surveyor;

GRANT EXECUTE ON FUNCTION caller_role() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION caller_role() TO int_viewer;

GRANT EXECUTE ON FUNCTION caller_role() TO web_anon;

GRANT EXECUTE ON FUNCTION caller_role() TO worker;

GRANT EXECUTE ON FUNCTION is_worker() TO ext_user;

GRANT EXECUTE ON FUNCTION is_worker() TO int_auditor;

GRANT EXECUTE ON FUNCTION is_worker() TO int_compliance;

GRANT EXECUTE ON FUNCTION is_worker() TO int_coordinator;

GRANT EXECUTE ON FUNCTION is_worker() TO int_finance;

GRANT EXECUTE ON FUNCTION is_worker() TO int_hr;

GRANT EXECUTE ON FUNCTION is_worker() TO int_manager;

GRANT EXECUTE ON FUNCTION is_worker() TO int_surveyor;

GRANT EXECUTE ON FUNCTION is_worker() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION is_worker() TO int_viewer;

GRANT EXECUTE ON FUNCTION is_worker() TO web_anon;

GRANT EXECUTE ON FUNCTION is_worker() TO worker;
