-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION reconciliation_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  raise exception 'audit reconciliation records are append-only';
end;
$$;

REVOKE EXECUTE ON FUNCTION reconciliation_append_only() FROM PUBLIC;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE TABLE IF NOT EXISTS controlled_column (
    schema_name text,
    table_name text,
    column_name text,
    regulated_event_type text,
    description text NOT NULL,
    CONSTRAINT controlled_column_pk PRIMARY KEY (schema_name, table_name, column_name)
);

ALTER TABLE controlled_column ENABLE ROW LEVEL SECURITY;

CREATE POLICY controlled_column_read ON controlled_column FOR SELECT TO audit_sealer, int_compliance, int_manager, int_sysadmin, worker USING (true);

CREATE TABLE IF NOT EXISTS forwarder_watermark (
    sink_id text,
    last_change_log_id bigint DEFAULT 0 NOT NULL,
    last_event_id bigint DEFAULT 0 NOT NULL,
    last_tx_id xid8,
    last_forwarded_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    forwarded_batch_count bigint DEFAULT 0 NOT NULL,
    forwarded_record_count bigint DEFAULT 0 NOT NULL,
    last_batch_hash text,
    updated_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT forwarder_watermark_pk PRIMARY KEY (sink_id)
);

ALTER TABLE forwarder_watermark ENABLE ROW LEVEL SECURITY;

CREATE POLICY forwarder_watermark_all ON forwarder_watermark TO audit_sealer, int_sysadmin, worker USING (true) WITH CHECK (true);

CREATE POLICY forwarder_watermark_read ON forwarder_watermark FOR SELECT TO int_compliance USING (true);

CREATE TABLE IF NOT EXISTS reconciliation_run (
    id bigint GENERATED ALWAYS AS IDENTITY,
    run_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL,
    from_xid xid8,
    to_xid xid8,
    checked_change_count integer NOT NULL,
    checked_event_count integer NOT NULL,
    discrepancy_count integer NOT NULL,
    status text NOT NULL,
    detail jsonb DEFAULT '{}' NOT NULL,
    CONSTRAINT reconciliation_run_pk PRIMARY KEY (id),
    CONSTRAINT reconciliation_run_status_ck CHECK (status IN ('clean'::text, 'discrepancies_found'::text, 'failed'::text))
);

CREATE INDEX IF NOT EXISTS reconciliation_run_time_ix ON reconciliation_run (run_at);

ALTER TABLE reconciliation_run ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_run_insert ON reconciliation_run FOR INSERT TO audit_sealer, worker WITH CHECK (true);

CREATE POLICY reconciliation_run_read ON reconciliation_run FOR SELECT TO audit_sealer, int_compliance, int_sysadmin, worker USING (true);

CREATE TABLE IF NOT EXISTS reconciliation_discrepancy (
    id bigint GENERATED ALWAYS AS IDENTITY,
    run_id bigint NOT NULL,
    detected_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    change_log_id bigint NOT NULL,
    tx_id xid8 NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    column_name text NOT NULL,
    row_id uuid,
    discrepancy_type text NOT NULL,
    details jsonb DEFAULT '{}' NOT NULL,
    CONSTRAINT reconciliation_discrepancy_pk PRIMARY KEY (id),
    CONSTRAINT reconciliation_discrepancy_change_fk FOREIGN KEY (change_log_id) REFERENCES change_log (id),
    CONSTRAINT reconciliation_discrepancy_run_fk FOREIGN KEY (run_id) REFERENCES reconciliation_run (id),
    CONSTRAINT reconciliation_discrepancy_type_ck CHECK (discrepancy_type IN ('missing_event'::text, 'mismatched_event_type'::text, 'event_failure_outcome'::text, 'unauthorized_mutation'::text))
);

CREATE INDEX IF NOT EXISTS reconciliation_discrepancy_run_ix ON reconciliation_discrepancy (run_id);

CREATE INDEX IF NOT EXISTS reconciliation_discrepancy_tx_ix ON reconciliation_discrepancy (tx_id);

ALTER TABLE reconciliation_discrepancy ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_discrepancy_insert ON reconciliation_discrepancy FOR INSERT TO audit_sealer, worker WITH CHECK (true);

CREATE POLICY reconciliation_discrepancy_read ON reconciliation_discrepancy FOR SELECT TO audit_sealer, int_compliance, int_sysadmin, worker USING (true);

ALTER TABLE controlled_column
ADD CONSTRAINT controlled_column_event_fk FOREIGN KEY (regulated_event_type) REFERENCES event_type (code);

CREATE OR REPLACE TRIGGER reconciliation_discrepancy_append_only
    BEFORE UPDATE OR DELETE ON reconciliation_discrepancy
    FOR EACH ROW
    EXECUTE FUNCTION private.reconciliation_append_only();

CREATE OR REPLACE TRIGGER reconciliation_run_append_only
    BEFORE UPDATE OR DELETE ON reconciliation_run
    FOR EACH ROW
    EXECUTE FUNCTION private.reconciliation_append_only();

ALTER POLICY change_log_read ON change_log TO audit_sealer, int_compliance, int_sysadmin, worker;

ALTER POLICY event_read ON event TO audit_sealer, int_compliance, int_sysadmin, worker;

GRANT SELECT ON TABLE change_log TO worker;

GRANT SELECT ON TABLE controlled_column TO audit_sealer;

GRANT SELECT ON TABLE controlled_column TO int_compliance;

GRANT SELECT ON TABLE controlled_column TO int_manager;

GRANT SELECT ON TABLE controlled_column TO int_sysadmin;

GRANT SELECT ON TABLE controlled_column TO worker;

GRANT SELECT ON TABLE event TO worker;

GRANT SELECT ON TABLE event_type TO audit_sealer;

GRANT SELECT ON TABLE event_type TO worker;

GRANT INSERT, SELECT, UPDATE ON TABLE forwarder_watermark TO audit_sealer;

GRANT SELECT ON TABLE forwarder_watermark TO int_compliance;

GRANT INSERT, SELECT, UPDATE ON TABLE forwarder_watermark TO int_sysadmin;

GRANT INSERT, SELECT, UPDATE ON TABLE forwarder_watermark TO worker;

GRANT INSERT, SELECT ON TABLE reconciliation_discrepancy TO audit_sealer;

GRANT SELECT ON TABLE reconciliation_discrepancy TO int_compliance;

GRANT SELECT ON TABLE reconciliation_discrepancy TO int_sysadmin;

GRANT INSERT, SELECT ON TABLE reconciliation_discrepancy TO worker;

GRANT INSERT, SELECT ON TABLE reconciliation_run TO audit_sealer;

GRANT SELECT ON TABLE reconciliation_run TO int_compliance;

GRANT SELECT ON TABLE reconciliation_run TO int_sysadmin;

GRANT INSERT, SELECT ON TABLE reconciliation_run TO worker;
