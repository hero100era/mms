-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

REVOKE EXECUTE ON FUNCTION pre_request() FROM authenticator;
