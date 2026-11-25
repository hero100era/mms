-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION seal_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  raise exception 'audit_trail.seal is append-only';
end;
$$;

REVOKE EXECUTE ON FUNCTION seal_append_only() FROM PUBLIC;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE TABLE IF NOT EXISTS seal (
    id bigint GENERATED ALWAYS AS IDENTITY,
    sealed_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    sealed_by text DEFAULT SESSION_USER NOT NULL,
    from_xid xid8 NOT NULL,
    to_xid xid8 NOT NULL,
    change_log_count integer NOT NULL,
    event_count integer NOT NULL,
    batch_hash text NOT NULL,
    prev_seal_hash text NOT NULL,
    seal_hash text NOT NULL,
    worm_uri text NOT NULL,
    worm_sha256 text NOT NULL,
    CONSTRAINT seal_pk PRIMARY KEY (id),
    CONSTRAINT seal_counts_ck CHECK (change_log_count >= 0 AND event_count >= 0),
    CONSTRAINT seal_hashes_length_ck CHECK (length(batch_hash) = 64 AND length(prev_seal_hash) = 64 AND length(seal_hash) = 64 AND length(worm_sha256) = 64),
    CONSTRAINT seal_xid_range_ck CHECK (from_xid <= to_xid)
);

CREATE INDEX IF NOT EXISTS seal_hash_ix ON seal (seal_hash);

CREATE INDEX IF NOT EXISTS seal_xid_ix ON seal (from_xid, to_xid);

ALTER TABLE seal ENABLE ROW LEVEL SECURITY;

CREATE POLICY seal_insert ON seal FOR INSERT TO audit_sealer WITH CHECK (true);

CREATE POLICY seal_read ON seal FOR SELECT TO audit_sealer, int_compliance, int_sysadmin USING (true);

CREATE OR REPLACE TRIGGER seal_append_only
    BEFORE UPDATE OR DELETE ON seal
    FOR EACH ROW
    EXECUTE FUNCTION private.seal_append_only();

ALTER POLICY change_log_read ON change_log TO audit_sealer, int_compliance, int_sysadmin;

ALTER POLICY event_read ON event TO audit_sealer, int_compliance, int_sysadmin;

GRANT SELECT ON TABLE change_log TO audit_sealer;

GRANT SELECT ON TABLE event TO audit_sealer;

GRANT INSERT, SELECT ON TABLE seal TO audit_sealer;

GRANT SELECT ON TABLE seal TO int_compliance;

GRANT SELECT ON TABLE seal TO int_sysadmin;
