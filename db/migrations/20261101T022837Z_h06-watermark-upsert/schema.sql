-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

GRANT EXECUTE ON FUNCTION caller_role() TO PUBLIC;

GRANT EXECUTE ON FUNCTION is_worker() TO PUBLIC;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE POLICY forwarder_watermark_write ON forwarder_watermark FOR SELECT TO audit_sealer, int_sysadmin, worker USING (true);
