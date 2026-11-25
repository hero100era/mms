-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

GRANT EXECUTE ON FUNCTION base32_decode(p_text text) TO auth_gateway;
