-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

GRANT EXECUTE ON FUNCTION break_glass_activate(p_user_id uuid, p_reason text, p_valid_until timestamp with time zone) TO PUBLIC;
