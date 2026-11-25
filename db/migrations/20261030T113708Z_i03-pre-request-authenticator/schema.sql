-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

GRANT EXECUTE ON FUNCTION pre_request() TO authenticator;
